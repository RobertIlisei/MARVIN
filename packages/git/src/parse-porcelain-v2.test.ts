import { describe, expect, it } from "vitest";

import { parsePorcelainV2 } from "./parse-porcelain-v2.js";

// Helper: build a NUL-delimited record stream the way `git status -z`
// emits it. Each record is NUL-terminated (so the final record ends
// with an empty trailing field).
const stream = (...records: string[]): string => `${records.join("\0")}\0`;

describe("parsePorcelainV2 — branch header", () => {
  it("parses a clean on-branch state", () => {
    const raw = stream(
      "# branch.oid 1234567890abcdef1234567890abcdef12345678",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +0 -0",
    );
    const result = parsePorcelainV2(raw);
    expect(result.branch).toEqual({
      oid: "1234567890abcdef1234567890abcdef12345678",
      name: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
    });
    expect(result.files).toEqual([]);
  });

  it("handles an initial-commit repo (no oid, no upstream)", () => {
    const raw = stream(
      "# branch.oid (initial)",
      "# branch.head main",
    );
    const result = parsePorcelainV2(raw);
    expect(result.branch.oid).toBeNull();
    expect(result.branch.name).toBe("main");
    expect(result.branch.upstream).toBeNull();
    expect(result.branch.ahead).toBeNull();
    expect(result.branch.behind).toBeNull();
  });

  it("handles a detached HEAD", () => {
    const raw = stream(
      "# branch.oid abc123",
      "# branch.head (detached)",
    );
    expect(parsePorcelainV2(raw).branch.name).toBeNull();
  });

  it("parses ahead / behind counters with N > 9", () => {
    const raw = stream("# branch.ab +15 -23");
    const result = parsePorcelainV2(raw);
    expect(result.branch.ahead).toBe(15);
    expect(result.branch.behind).toBe(23);
  });
});

describe("parsePorcelainV2 — file records", () => {
  it("parses an ordinary modified file", () => {
    const raw = stream(
      "# branch.head main",
      "1 .M N... 100644 100644 100644 abc def src/file.ts",
    );
    const result = parsePorcelainV2(raw);
    expect(result.files).toEqual([
      {
        path: "src/file.ts",
        indexStatus: ".",
        workingStatus: "M",
        renamedFrom: null,
        ordinary: true,
        entryType: "ordinary",
      },
    ]);
  });

  it("parses a staged-only modification", () => {
    const raw = stream(
      "# branch.head main",
      "1 M. N... 100644 100644 100644 abc def src/file.ts",
    );
    const files = parsePorcelainV2(raw).files;
    expect(files[0]?.indexStatus).toBe("M");
    expect(files[0]?.workingStatus).toBe(".");
  });

  it("parses a path containing spaces", () => {
    const raw = stream(
      "# branch.head main",
      "1 .M N... 100644 100644 100644 abc def file with spaces.txt",
    );
    expect(parsePorcelainV2(raw).files[0]?.path).toBe("file with spaces.txt");
  });

  it("parses a rename entry and picks up the original path from the NEXT record", () => {
    const raw = stream(
      "# branch.head main",
      "2 R. N... 100644 100644 100644 abc def R100 src/new-name.ts",
      "src/old-name.ts",
    );
    const result = parsePorcelainV2(raw);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toEqual({
      path: "src/new-name.ts",
      indexStatus: "R",
      workingStatus: ".",
      renamedFrom: "src/old-name.ts",
      ordinary: false,
      entryType: "rename-copy",
    });
  });

  it("parses a rename followed by further entries without eating them", () => {
    const raw = stream(
      "# branch.head main",
      "2 R. N... 100644 100644 100644 abc def R100 a.ts",
      "b.ts",
      "1 .M N... 100644 100644 100644 abc def c.ts",
      "? untracked.txt",
    );
    const result = parsePorcelainV2(raw);
    expect(result.files.map((f) => f.path)).toEqual([
      "a.ts",
      "c.ts",
      "untracked.txt",
    ]);
    expect(result.files[0]?.renamedFrom).toBe("b.ts");
    expect(result.files[2]?.entryType).toBe("untracked");
  });

  it("parses unmerged (conflicted) entries", () => {
    const raw = stream(
      "# branch.head feature",
      "u UU N... 100644 100644 100644 100644 abc def ghi src/conflict.ts",
    );
    const file = parsePorcelainV2(raw).files[0];
    expect(file?.entryType).toBe("unmerged");
    expect(file?.indexStatus).toBe("U");
    expect(file?.workingStatus).toBe("U");
    expect(file?.path).toBe("src/conflict.ts");
  });

  it("parses untracked and ignored entries", () => {
    const raw = stream(
      "# branch.head main",
      "? new.txt",
      "! ignored.log",
    );
    const files = parsePorcelainV2(raw).files;
    expect(files).toHaveLength(2);
    expect(files[0]?.entryType).toBe("untracked");
    expect(files[1]?.entryType).toBe("ignored");
  });

  it("is resilient to unknown record types (forward compat)", () => {
    const raw = stream(
      "# branch.head main",
      "X some future record",
      "1 .M N... 100644 100644 100644 abc def real.ts",
    );
    const files = parsePorcelainV2(raw).files;
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("real.ts");
  });

  it("is resilient to an empty input", () => {
    const result = parsePorcelainV2("");
    expect(result.files).toEqual([]);
    expect(result.branch.name).toBeNull();
  });
});
