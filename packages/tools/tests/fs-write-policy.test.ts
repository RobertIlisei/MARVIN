import { describe, expect, it } from "vitest";

import { fsWritePolicy, WRITE_SIZE_MAX_BYTES } from "../src/fs-write-policy";

// Security-critical policy classifier — lives between the sandbox helper
// and the mutation routes. Every decision it makes is load-bearing for
// ADR-0008 invariants, so each rule gets explicit coverage here.

const CWD = "/Users/me/project";

describe("fsWritePolicy — auto", () => {
  it("create-file inside project is auto", () => {
    const d = fsWritePolicy(
      { kind: "create-file", path: `${CWD}/src/new.ts`, bytes: 100 },
      CWD,
    );
    expect(d.class).toBe("auto");
  });

  it("create-dir inside project is auto", () => {
    const d = fsWritePolicy({ kind: "create-dir", path: `${CWD}/src/new` }, CWD);
    expect(d.class).toBe("auto");
  });

  it("rename inside project is auto", () => {
    const d = fsWritePolicy(
      { kind: "rename", from: `${CWD}/a.ts`, to: `${CWD}/b.ts` },
      CWD,
    );
    expect(d.class).toBe("auto");
  });

  it("move inside project is auto", () => {
    const d = fsWritePolicy(
      { kind: "move", from: [`${CWD}/a.ts`], to: `${CWD}/src` },
      CWD,
    );
    expect(d.class).toBe("auto");
  });

  it("delete-trash is auto — Trash is reversible", () => {
    const d = fsWritePolicy(
      { kind: "delete-trash", paths: [`${CWD}/gone.ts`] },
      CWD,
    );
    expect(d.class).toBe("auto");
  });
});

describe("fsWritePolicy — deny (hard-deny segments)", () => {
  it("create inside .git/ is deny", () => {
    const d = fsWritePolicy(
      { kind: "create-file", path: `${CWD}/.git/hook`, bytes: 10 },
      CWD,
    );
    expect(d.class).toBe("deny");
    expect(d.reason).toMatch(/\.git/);
  });

  it("write into node_modules is deny", () => {
    const d = fsWritePolicy(
      {
        kind: "write-file",
        path: `${CWD}/node_modules/foo/index.js`,
        bytes: 100,
        overwrite: true,
      },
      CWD,
    );
    expect(d.class).toBe("deny");
    expect(d.reason).toMatch(/node_modules/);
  });

  it("rename into .next/ is deny", () => {
    const d = fsWritePolicy(
      { kind: "rename", from: `${CWD}/a.ts`, to: `${CWD}/.next/cached` },
      CWD,
    );
    expect(d.class).toBe("deny");
    expect(d.reason).toContain(".next");
  });

  it("move into .turbo/ is deny", () => {
    const d = fsWritePolicy(
      { kind: "move", from: [`${CWD}/a.ts`], to: `${CWD}/.turbo/sneak` },
      CWD,
    );
    expect(d.class).toBe("deny");
  });
});

describe("fsWritePolicy — deny (project-root guard)", () => {
  it("delete-trash including cwd is deny", () => {
    const d = fsWritePolicy(
      { kind: "delete-trash", paths: [CWD] },
      CWD,
    );
    expect(d.class).toBe("deny");
    expect(d.reason).toContain("project root");
  });

  it("delete-permanent including cwd is deny", () => {
    const d = fsWritePolicy(
      { kind: "delete-permanent", paths: [CWD] },
      CWD,
    );
    expect(d.class).toBe("deny");
  });

  it("move from cwd is deny", () => {
    const d = fsWritePolicy(
      { kind: "move", from: [CWD], to: `${CWD}/elsewhere` },
      CWD,
    );
    expect(d.class).toBe("deny");
  });
});

describe("fsWritePolicy — deny (size + structural)", () => {
  it("write-file over WRITE_SIZE_MAX_BYTES is deny", () => {
    const d = fsWritePolicy(
      {
        kind: "write-file",
        path: `${CWD}/big.txt`,
        bytes: WRITE_SIZE_MAX_BYTES + 1,
        overwrite: true,
      },
      CWD,
    );
    expect(d.class).toBe("deny");
    expect(d.reason).toMatch(/cap/);
  });

  it("rename to same path is deny", () => {
    const d = fsWritePolicy(
      { kind: "rename", from: `${CWD}/a.ts`, to: `${CWD}/a.ts` },
      CWD,
    );
    expect(d.class).toBe("deny");
  });

  it("move with empty source list is deny", () => {
    const d = fsWritePolicy(
      { kind: "move", from: [], to: `${CWD}/dest` },
      CWD,
    );
    expect(d.class).toBe("deny");
  });

  it("delete with empty path list is deny", () => {
    const d = fsWritePolicy({ kind: "delete-trash", paths: [] }, CWD);
    expect(d.class).toBe("deny");
  });

  it("path containing NUL byte is deny", () => {
    const d = fsWritePolicy(
      { kind: "create-file", path: `${CWD}/bad\0file`, bytes: 1 },
      CWD,
    );
    expect(d.class).toBe("deny");
  });
});

describe("fsWritePolicy — confirm (secret files)", () => {
  it("writing .env is confirm danger", () => {
    const d = fsWritePolicy(
      { kind: "create-file", path: `${CWD}/.env`, bytes: 100 },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });

  it("writing .env.local is confirm danger", () => {
    const d = fsWritePolicy(
      {
        kind: "write-file",
        path: `${CWD}/.env.local`,
        bytes: 100,
        overwrite: true,
      },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });

  it("writing id_rsa is confirm danger", () => {
    const d = fsWritePolicy(
      { kind: "create-file", path: `${CWD}/id_rsa`, bytes: 100 },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });

  it("renaming a .pem file is confirm danger", () => {
    const d = fsWritePolicy(
      { kind: "rename", from: `${CWD}/cert.pem`, to: `${CWD}/old.pem` },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });

  it("trashing a secret is confirm danger", () => {
    const d = fsWritePolicy(
      { kind: "delete-trash", paths: [`${CWD}/.env`] },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });
});

describe("fsWritePolicy — confirm (case-only rename)", () => {
  it("Foo.ts → foo.ts is confirm warn", () => {
    const d = fsWritePolicy(
      { kind: "rename", from: `${CWD}/Foo.ts`, to: `${CWD}/foo.ts` },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("warn");
    expect(d.reason).toMatch(/case/);
  });

  it("Foo.ts → Bar.ts is auto (not a case collision)", () => {
    const d = fsWritePolicy(
      { kind: "rename", from: `${CWD}/Foo.ts`, to: `${CWD}/Bar.ts` },
      CWD,
    );
    expect(d.class).toBe("auto");
  });
});

describe("fsWritePolicy — confirm (permanent delete always)", () => {
  it("delete-permanent of a regular file is confirm danger", () => {
    const d = fsWritePolicy(
      { kind: "delete-permanent", paths: [`${CWD}/a.ts`] },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
    expect(d.reason).toMatch(/irreversible/);
  });

  it("delete-permanent of many files is still confirm", () => {
    const d = fsWritePolicy(
      {
        kind: "delete-permanent",
        paths: [`${CWD}/a`, `${CWD}/b`, `${CWD}/c`],
      },
      CWD,
    );
    expect(d.class).toBe("confirm");
    expect(d.reason).toMatch(/3 item/);
  });
});
