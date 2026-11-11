import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listInbox } from "../src/supervisor-inbox";
import { readLedger } from "../src/supervisor-ledger";
import { approveEntries, type QueueEntryProposal, readQueue, updateQueue } from "../src/supervisor-queue";
import { defaultOpenerDeps, type OpenerDeps, QueueOpener } from "../src/supervisor-queue-opener";
import { checkScopeRef, resolveInsideProject } from "../src/supervisor-queue-scope";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "../src/supervisor-state";
import { readWorktreeSetupConfig } from "../src/worktree-setup";

// ADR-0133 decision 5 — scope is checked, not remembered: a text comparison
// against the project's own plan, by the runtime, at open time.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "plan" as const, personality: "marvin" as const };
const PLAN = [
  "# Roadmap",
  "",
  "## Wave 8",
  "- H3 harvest dashboard",
  "- H4 export",
  "### Wave 8 notes",
  "- H5 mentioned in a nested section",
  "",
  "## Deferred to v3.1",
  "- H9 crop rotation",
  "- H4 export (moved here later)",
  "",
  "```",
  "## Wave 8",
  "- H7 inside a fence is not a heading",
  "```",
  "",
].join("\n");
const write = (rel: string, body: string) => {
  mkdirSync(path.dirname(path.join(workDir, rel)), { recursive: true });
  writeFileSync(path.join(workDir, rel), body);
};
const entry = (id: string, scopeRef?: { path: string; heading: string }): QueueEntryProposal => ({ id, title: id, brief: id, posture: POSTURE, wider: [], ...(scopeRef ? { scopeRef } : {}) });

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-scope-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-scope-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: "proj", action: "start" }, currentSupervisorToken());
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("deferredHeadings is validated where it is read", () => {
  const read = (v: unknown) => {
    write(".marvin/worktree.json", JSON.stringify({ deferredHeadings: v }));
    return readWorktreeSetupConfig(workDir).deferredHeadings;
  };
  it("keeps plain heading text, strips leading #s, drops non-strings, control characters, duplicates and the over-long", () => {
    expect(read(["## Deferred to v3.1", "Later", "Later", 7, null, {}, ["x"], "a\nb", "a\u0000b", "x".repeat(201), "  "])).toEqual(["Deferred to v3.1", "Later"]);
  });
  it("caps the count, and an absent, empty or non-array value adds no key at all", () => {
    expect(read(Array.from({ length: 100 }, (_, i) => `H${i}`))).toHaveLength(32);
    expect(read("Deferred")).toBeUndefined();
    expect(read([])).toBeUndefined();
    write(".marvin/worktree.json", "{}");
    expect("deferredHeadings" in readWorktreeSetupConfig(workDir)).toBe(false);
  });
});

describe("checkScopeRef", () => {
  beforeEach(() => {
    write("docs/plan.md", PLAN);
    write(".marvin/worktree.json", JSON.stringify({ deferredHeadings: ["Deferred to v3.1"] }));
  });
  const ref = { path: "docs/plan.md", heading: "Wave 8" };

  it("passes an id that still sits under its heading, nested sections included", () => {
    expect(checkScopeRef(workDir, { id: "H3", scopeRef: ref })).toEqual({ ok: true });
    expect(checkScopeRef(workDir, { id: "H5", scopeRef: ref })).toEqual({ ok: true });
  });

  it("holds an id found under a deferred heading, naming both lines", () => {
    const v = checkScopeRef(workDir, { id: "H4", scopeRef: ref });
    expect(v).toMatchObject({ ok: false, reason: expect.stringContaining("deferred heading") });
    if (!v.ok) {
      expect(v.detail).toContain("docs/plan.md line 3");
      expect(v.detail).toContain("docs/plan.md line 11");
      expect(v.detail).toContain("Deferred to v3.1");
    }
  });

  it("holds an id that is not under the heading any more (and one that is only in a code fence)", () => {
    expect(checkScopeRef(workDir, { id: "H9", scopeRef: ref })).toMatchObject({ ok: false, reason: expect.stringContaining("deferred") });
    // The fenced "## Wave 8" is not a heading, so H7 still sits under "Deferred to v3.1".
    expect(checkScopeRef(workDir, { id: "H7", scopeRef: ref })).toMatchObject({ ok: false, reason: expect.stringContaining("deferred") });
    expect(checkScopeRef(workDir, { id: "H33", scopeRef: ref })).toMatchObject({ ok: false });
  });

  it("matches the whole id: H3 is not H30", () => {
    write("docs/plan.md", "## Wave 8\n- H30 something\n");
    expect(checkScopeRef(workDir, { id: "H3", scopeRef: ref })).toMatchObject({ ok: false });
  });

  it("holds when the heading itself is gone", () => {
    expect(checkScopeRef(workDir, { id: "H3", scopeRef: { path: "docs/plan.md", heading: "Wave 9" } })).toMatchObject({ ok: false, reason: expect.stringContaining('no heading "Wave 9"') });
  });

  it("an entry without a scopeRef is not checked", () => {
    expect(checkScopeRef(workDir, { id: "anything" })).toEqual({ ok: true });
  });

  it("the path must resolve inside the project: traversal, absolute, a missing file, a symlink out (followed first)", () => {
    const outside = path.join(dataDir, "outside.md");
    writeFileSync(outside, PLAN);
    symlinkSync(outside, path.join(workDir, "docs", "link.md"));
    symlinkSync(path.join(workDir, "docs", "plan.md"), path.join(workDir, "docs", "inside-link.md"));
    for (const p of ["../outside.md", "docs/../../x.md", outside, "docs/missing.md", "docs/link.md"]) {
      expect(resolveInsideProject(workDir, p)).toMatchObject({ ok: false });
      expect(checkScopeRef(workDir, { id: "H3", scopeRef: { path: p, heading: "Wave 8" } })).toMatchObject({ ok: false });
    }
    expect(resolveInsideProject(workDir, "docs/inside-link.md")).toMatchObject({ ok: true });
  });
});

describe("the opener and scopeRef", () => {
  const deps = (over: Partial<OpenerDeps> = {}) => {
    const opened: string[] = [];
    let now = Date.now();
    const d: OpenerDeps = {
      pid: 1,
      isAlive: () => true,
      now: () => now,
      workDirOf: () => workDir,
      supervisorRefusal: () => null,
      openTabCount: () => 0,
      mergedBranches: async () => new Set(),
      diskRefusal: () => null,
      open: async (_p, _w, e) => {
        opened.push(e.id);
        return { ok: true, marvinSessionId: `tab-${e.id}`, branch: `marvin/tab/${e.id}` };
      },
      ...over,
    };
    return { d, opened, advance: (ms: number) => (now += ms) };
  };
  beforeEach(() => {
    write("docs/plan.md", PLAN);
    write(".marvin/worktree.json", JSON.stringify({ deferredHeadings: ["Deferred to v3.1"] }));
    updateQueue("proj", "cap", (q) => {
      q.cap = 5;
    });
  });
  const ref = { path: "docs/plan.md", heading: "Wave 8" };

  it("opens an entry whose id holds, holds one the plan deferred — and escalates once, naming both lines", async () => {
    approveEntries("proj", [entry("H3", ref), entry("H4", ref)]);
    const { d, opened } = deps();
    // The default deps wire the real check and the card; only the world is faked.
    const wired: OpenerDeps = { ...defaultOpenerDeps(), ...d };
    const o = new QueueOpener(wired);
    await o.kick("proj");
    await o.kick("proj");
    expect(opened).toEqual(["H3"]);
    expect(readQueue("proj").entries.find((e) => e.id === "H4")).toMatchObject({ status: "queued", blocked: { code: "scope", reason: expect.stringContaining("deferred heading") } });
    const cards = listInbox("proj").filter((i) => i.kind === "queue");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.queue).toMatchObject({ kind: "hold", entryId: "H4", detail: expect.stringMatching(/line 3.*line 11/s) });
    expect(cards[0]?.act).toBeNull();
    expect(readLedger("proj").filter((l) => l.verb === "queue.scope")).toHaveLength(1);
  });

  it("when the plan is fixed the entry opens, with no manual step", async () => {
    approveEntries("proj", [entry("H4", ref)]);
    const { d, opened } = deps();
    const wired: OpenerDeps = { ...defaultOpenerDeps(), ...d };
    const o = new QueueOpener(wired);
    await o.kick("proj");
    expect(opened).toEqual([]);
    write("docs/plan.md", PLAN.replace("- H4 export (moved here later)\n", "").replace("- H3 harvest dashboard", "- H3 harvest dashboard\n"));
    await o.kick("proj");
    expect(opened).toEqual(["H4"]);
  });
});

describe("invariant 9 — an entry unopened 7 days after approval expires", () => {
  const DAY = 24 * 3600 * 1000;
  const fakeDeps = (now: number, opened: string[]): OpenerDeps => ({
    pid: 1,
    isAlive: () => true,
    now: () => now,
    workDirOf: () => workDir,
    supervisorRefusal: () => null,
    openTabCount: () => 0,
    mergedBranches: async () => new Set(),
    diskRefusal: () => null,
    open: async (_p, _w, e) => {
      opened.push(e.id);
      return { ok: true, marvinSessionId: `tab-${e.id}`, branch: "b" };
    },
  });

  it("opens at 6 days, expires at 8, and ledgers the expiry; a successor then waits on an expired predecessor", async () => {
    approveEntries("proj", [entry("A"), { ...entry("B"), after: ["A"] }]);
    const approvedAt = Date.parse(readQueue("proj").entries[0]?.approvedAt as string);
    updateQueue("proj", "cap", (q) => {
      q.cap = 5;
    });
    const six: string[] = [];
    await new QueueOpener(fakeDeps(approvedAt + 6 * DAY, six)).kick("proj");
    expect(six).toEqual(["A"]);

    approveEntries("proj", [entry("C"), { ...entry("D"), after: ["C"] }]);
    // Eight days after C was approved, nothing has opened it.
    const eight: string[] = [];
    await new QueueOpener(fakeDeps(Date.parse(readQueue("proj").entries.find((e) => e.id === "C")?.approvedAt as string) + 8 * DAY, eight)).kick("proj");
    expect(eight).toEqual([]);
    const q = readQueue("proj");
    expect(q.entries.find((e) => e.id === "C")?.status).toBe("expired");
    expect(q.entries.find((e) => e.id === "D")?.status).toBe("expired");
    expect(readLedger("proj").filter((l) => l.verb === "queue.expired").map((l) => l.reasonCode)).toEqual(["expired", "expired", "expired"]);
  });
});
