import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __clearCheckpointsForTests,
  acceptAll,
  acceptFile,
  acceptHunk,
  diffFile,
  listChanges,
  recordPreImage,
  reconcileCommitted,
  rejectAll,
  rejectFile,
  rejectHunk,
} from "../src/change-checkpoints";

// ADR-0034: Cursor-style change review. The hunk accept/reject semantics
// are the load-bearing part — accept advances the BASELINE (so later
// "reject all" keeps accepted work), reject reverse-applies to DISK.
// These tests pin both directions plus the added/deleted-file edges.

const KEY = { projectId: "proj-t", marvinSessionId: "sess-t" };
let cwd: string;

function fileAbs(rel: string): string {
  return path.join(cwd, rel);
}

function seed(rel: string, content: string): void {
  mkdirSync(path.dirname(fileAbs(rel)), { recursive: true });
  writeFileSync(fileAbs(rel), content, "utf-8");
}

function agentWrites(rel: string, content: string): void {
  // recordPreImage runs BEFORE the write, like the gate does.
  recordPreImage({ key: KEY, cwd, turnId: "turn-1", absPath: fileAbs(rel) });
  seed(rel, content);
}

beforeEach(() => {
  process.env.MARVIN_DATA_DIR = mkdtempSync(path.join(tmpdir(), "marvin-ckpt-data-"));
  cwd = mkdtempSync(path.join(tmpdir(), "marvin-ckpt-ws-"));
  __clearCheckpointsForTests(KEY);
});

afterEach(() => {
  __clearCheckpointsForTests(KEY);
  delete process.env.MARVIN_DATA_DIR;
});

describe("recording + listing", () => {
  it("a modified file appears with counts; first touch wins the baseline", () => {
    seed("a.txt", "one\ntwo\nthree\n");
    agentWrites("a.txt", "one\nTWO\nthree\n");
    // Second touch must NOT re-baseline to the already-edited content.
    agentWrites("a.txt", "one\nTWO!\nthree\n");
    const changes = listChanges(KEY);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "a.txt", status: "modified" });
    expect(changes[0]?.additions).toBe(1);
    expect(changes[0]?.deletions).toBe(1);
  });

  it("a committed agent change drops from the review; an uncommitted one stays", () => {
    // ADR-0034 follow-up: a committed change is an accepted one — it should
    // leave the review set the way it leaves VS Code's Source Control list.
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    git("init", "-q");
    git("config", "user.email", "t@t.test");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-q", "-m", "root");

    // Two files the agent edits. baseline (pre-touch) captured by agentWrites.
    seed("kept.txt", "k1\n");
    seed("done.txt", "d1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    agentWrites("kept.txt", "k1\nk2\n");
    agentWrites("done.txt", "d1\nd2\n");
    expect(listChanges(KEY).map((c) => c.path).sort()).toEqual(["done.txt", "kept.txt"]);

    // Commit only done.txt — its change is now in HEAD, kept.txt is not.
    git("add", "done.txt");
    git("commit", "-q", "-m", "land done.txt");

    const dropped = reconcileCommitted(KEY, cwd);
    expect(dropped).toEqual(["done.txt"]);
    expect(listChanges(KEY).map((c) => c.path)).toEqual(["kept.txt"]);
  });

  it("reconcile is a no-op outside a git repo", () => {
    agentWrites("a.txt", "one\n");
    expect(reconcileCommitted(KEY, cwd)).toEqual([]);
    expect(listChanges(KEY)).toHaveLength(1);
  });

  it("an agent-created file lists as added; agent-deleted as deleted", () => {
    agentWrites("new.txt", "hello\n");
    seed("old.txt", "bye\n");
    recordPreImage({ key: KEY, cwd, turnId: "turn-1", absPath: fileAbs("old.txt") });
    // simulate the agent emptying/removing it via Write of empty + manual rm
    writeFileSync(fileAbs("old.txt"), "", "utf-8");
    // a true deletion:
    require("node:fs").unlinkSync(fileAbs("old.txt"));
    const byPath = Object.fromEntries(listChanges(KEY).map((c) => [c.path, c.status]));
    expect(byPath["new.txt"]).toBe("added");
    expect(byPath["old.txt"]).toBe("deleted");
  });

  it("GCs entries whose content returned to baseline", () => {
    seed("a.txt", "same\n");
    agentWrites("a.txt", "different\n");
    seed("a.txt", "same\n"); // agent (or user) reverted it manually
    expect(listChanges(KEY)).toHaveLength(0);
  });

  it("ignores paths outside the workspace", () => {
    recordPreImage({ key: KEY, cwd, turnId: "t", absPath: "/etc/hosts" });
    expect(listChanges(KEY)).toHaveLength(0);
  });
});

describe("file-level accept / reject", () => {
  it("rejectFile restores the pre-agent content, not git HEAD", () => {
    seed("a.txt", "user-uncommitted-state\n");
    agentWrites("a.txt", "agent-version\n");
    expect(rejectFile(KEY, "a.txt")).toBe(true);
    expect(readFileSync(fileAbs("a.txt"), "utf-8")).toBe("user-uncommitted-state\n");
    expect(listChanges(KEY)).toHaveLength(0);
  });

  it("rejectFile on an agent-added file deletes it", () => {
    agentWrites("created.txt", "agent made me\n");
    expect(rejectFile(KEY, "created.txt")).toBe(true);
    expect(existsSync(fileAbs("created.txt"))).toBe(false);
  });

  it("acceptFile keeps disk content and clears the entry", () => {
    seed("a.txt", "before\n");
    agentWrites("a.txt", "after\n");
    expect(acceptFile(KEY, "a.txt")).toBe(true);
    expect(readFileSync(fileAbs("a.txt"), "utf-8")).toBe("after\n");
    expect(listChanges(KEY)).toHaveLength(0);
  });
});

describe("hunk-level accept / reject", () => {
  // Two edits far enough apart to produce two distinct hunks.
  const BASE = `${"line\n".repeat(1)}alpha\n${"pad\n".repeat(10)}omega\n`;
  const EDITED = `${"line\n".repeat(1)}ALPHA\n${"pad\n".repeat(10)}OMEGA\n`;

  function setupTwoHunks(): void {
    seed("two.txt", BASE);
    agentWrites("two.txt", EDITED);
  }

  it("produces two hunks for two separated edits", () => {
    setupTwoHunks();
    const d = diffFile(KEY, "two.txt");
    expect(d?.hunks).toHaveLength(2);
  });

  it("rejectHunk reverts only that hunk on disk", () => {
    setupTwoHunks();
    expect(rejectHunk(KEY, "two.txt", 0)).toBe(true);
    const now = readFileSync(fileAbs("two.txt"), "utf-8");
    expect(now).toContain("alpha"); // first edit reverted
    expect(now).toContain("OMEGA"); // second edit intact
    // One pending hunk remains.
    expect(diffFile(KEY, "two.txt")?.hunks).toHaveLength(1);
  });

  it("acceptHunk advances the baseline so reject-all keeps accepted work", () => {
    setupTwoHunks();
    expect(acceptHunk(KEY, "two.txt", 0)).toBe(true); // accept ALPHA
    expect(rejectAll(KEY)).toBe(1); // reject the rest
    const now = readFileSync(fileAbs("two.txt"), "utf-8");
    expect(now).toContain("ALPHA"); // accepted hunk survived
    expect(now).toContain("omega"); // unaccepted hunk reverted
    expect(listChanges(KEY)).toHaveLength(0);
  });

  it("accepting every hunk settles the file", () => {
    setupTwoHunks();
    expect(acceptHunk(KEY, "two.txt", 0)).toBe(true);
    // After the first accept the remaining diff has one hunk, index 0.
    expect(acceptHunk(KEY, "two.txt", 0)).toBe(true);
    expect(listChanges(KEY)).toHaveLength(0);
    expect(readFileSync(fileAbs("two.txt"), "utf-8")).toBe(EDITED);
  });

  it("a stale hunk index misses safely", () => {
    setupTwoHunks();
    expect(rejectHunk(KEY, "two.txt", 7)).toBe(false);
    expect(readFileSync(fileAbs("two.txt"), "utf-8")).toBe(EDITED);
  });
});

describe("bulk operations", () => {
  it("acceptAll clears everything, rejectAll restores everything", () => {
    seed("x.txt", "x0\n");
    agentWrites("x.txt", "x1\n");
    agentWrites("y.txt", "y1\n"); // added
    expect(acceptAll(KEY)).toBe(2);
    expect(listChanges(KEY)).toHaveLength(0);
    expect(readFileSync(fileAbs("x.txt"), "utf-8")).toBe("x1\n");

    // Round two: reject path.
    agentWrites("x.txt", "x2\n");
    agentWrites("z.txt", "z1\n");
    expect(rejectAll(KEY)).toBe(2);
    expect(readFileSync(fileAbs("x.txt"), "utf-8")).toBe("x1\n");
    expect(existsSync(fileAbs("z.txt"))).toBe(false);
  });
});
