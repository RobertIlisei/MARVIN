import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectNumberedElsewhere, findCollisions, sequenceToken } from "../src/numbered-file-collision";

describe("sequenceToken — what counts as a numbered file", () => {
  it.each([
    ["docs/adr/0491-errors.md", "0491"],
    ["db/migration/V202610021010__retry.sql", "V202610021010"],
    ["db/migrate/0042_add_users.py", "0042"],
    ["migrations/v2.1.3__x.sql", null], // a dotted version with 1-digit head is not a sequence
    ["docs/handoff/2026-10-02-h10a.md", null], // a date, not a sequence
    ["README.md", null],
    ["src/12.ts", null],
  ])("%s → %s", (p, tok) => {
    expect(sequenceToken(p)).toBe(tok);
  });
});

describe("findCollisions — same directory, same number, different file", () => {
  it("flags an ADR number taken by a sibling and suggests the next free one", () => {
    const c = findCollisions(["docs/adr/0495-exit-pack.md"], [
      { path: "docs/adr/0495-anaf-sender.md", where: "/wt/h6" },
      { path: "docs/adr/0497-parity.md", where: "/wt/h7b" },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]?.theirs.path).toBe("docs/adr/0495-anaf-sender.md");
    expect(c[0]?.suggestion).toBe("0498");
  });
  it("flags a migration version and keeps the letter prefix", () => {
    const c = findCollisions(["db/V202610021010__a.sql"], [{ path: "db/V202610021010__b.sql", where: "HEAD" }]);
    expect(c[0]?.suggestion).toBe("V202610021011");
  });
  it("ignores the same file, other directories and dated names", () => {
    expect(findCollisions(["docs/adr/0491-x.md"], [{ path: "docs/adr/0491-x.md", where: "/wt" }])).toEqual([]);
    expect(findCollisions(["a/0491-x.md"], [{ path: "b/0491-y.md", where: "/wt" }])).toEqual([]);
    expect(findCollisions(["h/2026-10-02-a.md"], [{ path: "h/2026-10-02-b.md", where: "/wt" }])).toEqual([]);
  });
});

describe("collectNumberedElsewhere — real worktrees", () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();
  it("sees a sibling worktree's committed and uncommitted numbered files", () => {
    const root = mkdtempSync(join(tmpdir(), "nfc-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "docs/adr"), { recursive: true });
    sh(root, "init", "-q", "-b", "main", repo);
    sh(repo, "config", "user.email", "t@t"); sh(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "docs/adr/0001-first.md"), "x");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "init");
    sh(repo, "worktree", "add", "-q", "-b", "a", join(root, "a"));
    sh(repo, "worktree", "add", "-q", "-b", "b", join(root, "b"));
    writeFileSync(join(root, "b/docs/adr/0002-from-b.md"), "y");
    sh(join(root, "b"), "add", "."); sh(join(root, "b"), "commit", "-qm", "b");
    writeFileSync(join(root, "b/docs/adr/0003-pending.md"), "z");
    const seen = collectNumberedElsewhere(join(root, "a"), ["docs/adr/0002-from-a.md"]).map((f) => f.path).sort();
    expect(seen).toEqual(["docs/adr/0001-first.md", "docs/adr/0002-from-b.md", "docs/adr/0003-pending.md"]);
    const c = findCollisions(["docs/adr/0002-from-a.md"], collectNumberedElsewhere(join(root, "a"), ["docs/adr/0002-from-a.md"]));
    expect(c[0]?.suggestion).toBe("0004");
  });
});

import { checkNumberedCollision, createTurnDesignContext } from "../src/design-hooks";

describe("checkNumberedCollision — the commit gate", () => {
  const collect = () => ({ files: ["docs/adr/0495-mine.md", "src/x.ts"], changedLines: 10 });
  const isNew = () => true;
  it("refuses a commit whose new numbered file collides, twice, then allows and stops refusing", () => {
    const ctx = createTurnDesignContext("t-nfc", "/tmp");
    const elsewhere = () => [{ path: "docs/adr/0495-theirs.md", where: "/wt/other" }];
    const first = checkNumberedCollision(ctx, "Bash", { command: "git commit -m x" }, collect, elsewhere, isNew);
    expect(first?.behavior).toBe("deny");
    expect(first && "message" in first ? first.message : "").toMatch(/0496/);
    expect(checkNumberedCollision(ctx, "Bash", { command: "git commit -m x" }, collect, elsewhere, isNew)?.behavior).toBe("deny");
    expect(checkNumberedCollision(ctx, "Bash", { command: "git commit -m x" }, collect, elsewhere, isNew)).toBeNull();
  });
  it("allows a commit with no collision, and ignores non-commit commands", () => {
    const ctx = createTurnDesignContext("t-nfc2", "/tmp");
    expect(checkNumberedCollision(ctx, "Bash", { command: "git commit -m x" }, collect, () => [], isNew)).toBeNull();
    expect(checkNumberedCollision(ctx, "Bash", { command: "git status" }, collect, () => [{ path: "docs/adr/0495-t.md", where: "x" }], isNew)).toBeNull();
  });
});
