import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLedger } from "../src/supervisor-ledger";
import { approveMerge, GATE_DEFAULT_TIMEOUT_MS, type MergeProposal, readMerge, revokeMerge } from "../src/supervisor-merge";
import { argvViolation, defaultPassDeps, MergePass, MergeRunner, type PassDeps, type PassResult } from "../src/supervisor-merge-pass";
import { acquireMergeLock, clearStaleMergeLocks, mergeLockPath } from "../src/supervisor-queue-lock";
import { bootSupervisor, resetSupervisorStateForTests } from "../src/supervisor-state";
import type { ProjectEvent } from "../src/turn-registry";
import { createSessionWorktree, markSessionWorktreeClosed, mergeAllWorktrees, reconcileWorktrees } from "../src/worktrees";

// ADR-0134 invariants 1, 3–8 — the pass, on REAL git in temporary repositories.
// A clean merge with gate 0 fast-forwards `target`; a failing gate leaves it
// alone and no scratch tree behind; a predicted conflict is skipped with no gate
// run; a target that moved under the gate is discarded and retried; a dirty
// checkout makes the fast-forward wait; and every git argv the pass issued is
// checked against the never-list.

const PROJECT = "proj";
let dataDir: string;
let workDir: string;
const prevData = process.env.MARVIN_DATA_DIR;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ref = (name: string) => git(workDir, "rev-parse", `refs/heads/${name}`);
const proposal = (extra: Partial<MergeProposal> = {}): MergeProposal => ({ target: "integration", gate: "exit 0", timeoutMs: GATE_DEFAULT_TIMEOUT_MS, holds: [], validForHours: 24, timeZone: "UTC", ...extra });
const authorise = (extra: Partial<MergeProposal> = {}) => {
  const r = approveMerge(PROJECT, proposal(extra));
  if (!r.ok) throw new Error(r.error);
};

interface TabOpts {
  scopeMet?: boolean;
  closed?: boolean;
  dirty?: boolean;
}
const metas = new Map<string, { scopeMetAt?: string | undefined; closedAt?: string | undefined }>();
let counter = 0;

/** A finished tab: a session worktree with one commit, its tab closed (so its branch derives `ready`). */
function makeTab(name: string, files: Record<string, string>, opts: TabOpts = {}): { branch: string; sessionId: string; dir: string } {
  const sessionId = `sess-${name}-${++counter}`;
  const rec = createSessionWorktree(workDir, { sessionId, title: name });
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(rec.path, f)), { recursive: true });
    writeFileSync(path.join(rec.path, f), content);
  }
  git(rec.path, "add", "-A");
  git(rec.path, "commit", "-q", "-m", `work: ${name}`);
  if (opts.dirty) writeFileSync(path.join(rec.path, "uncommitted.txt"), "wip");
  if (opts.closed !== false) markSessionWorktreeClosed(workDir, sessionId);
  metas.set(sessionId, { scopeMetAt: opts.scopeMet === false ? undefined : new Date().toISOString(), closedAt: opts.closed === false ? undefined : new Date().toISOString() });
  return { branch: rec.branch, sessionId, dir: rec.path };
}

interface Harness {
  calls: string[][];
  gateRuns: string[];
  reports: Array<{ sessionId: string; text: string }>;
  closed: string[];
  pass: MergePass;
  deps: PassDeps;
  run(signal?: AbortSignal): Promise<PassResult>;
}

function harness(over: Partial<PassDeps> = {}): Harness {
  const calls: string[][] = [];
  const gateRuns: string[] = [];
  const reports: Harness["reports"] = [];
  const closed: string[] = [];
  const base = defaultPassDeps();
  const deps: PassDeps = {
    ...base,
    workDirOf: () => workDir,
    supervisorRefusal: () => null,
    diskRefusal: () => null,
    exec: (cwd, args) => {
      calls.push(args);
      return base.exec(cwd, args);
    },
    sessionOf: (_p, id) => metas.get(id) ?? null,
    runGate: async (wd, cwd, command, opts) => {
      gateRuns.push(cwd);
      return base.runGate(wd, cwd, command, opts);
    },
    report: async (_p, sessionId, text) => {
      reports.push({ sessionId, text });
      return "recorded";
    },
    closeTab: async (_p, _w, sessionId) => {
      closed.push(sessionId);
      return { ok: true, message: "closed" };
    },
    ...over,
  };
  const pass = new MergePass(deps);
  return { calls, gateRuns, reports, closed, pass, deps, run: (signal) => pass.run(PROJECT, signal) };
}

const FORBIDDEN_CMDS = new Set(["push", "tag", "fetch", "pull", "reset", "branch", "rebase", "checkout", "switch", "clean", "gc", "stash", "cherry-pick", "revert", "commit", "restore", "symbolic-ref", "remote", "config"]);

/** Invariant 3, asserted on the argv the pass really issued. */
function expectSafeArgv(h: Harness, target = "integration") {
  const ctx = { target, scratchRoot: h.deps.scratchRoot(PROJECT) };
  expect(h.calls.length).toBeGreaterThan(0);
  for (const raw of h.calls) {
    const args = raw[0] === "-c" ? raw.slice(2) : raw;
    expect(argvViolation(raw, ctx), raw.join(" ")).toBeNull();
    expect(FORBIDDEN_CMDS.has(args[0] ?? ""), raw.join(" ")).toBe(false);
    expect(args.some((a) => a === "--hard" || a === "-D" || a === "-d" || a === "--delete" || a === "--mirror" || a === "--force-with-lease"), raw.join(" ")).toBe(false);
    // The one force there is: removing the pass's own scratch worktree.
    if (args.includes("--force") || args.includes("-f")) expect(args[0] === "worktree" && args[1] === "remove" && args[2] === "--force" && args[3]?.startsWith(ctx.scratchRoot), raw.join(" ")).toBe(true);
    if (args[0] === "update-ref") expect(args[1]).toBe(`refs/heads/${target}`);
  }
}

function scratchTrees(): string[] {
  const root = path.join(dataDir, "merge-scratch", PROJECT);
  return existsSync(root) ? readdirSync(root) : [];
}
const worktreePaths = () => git(workDir, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-mpass-data-")));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-mpass-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  metas.clear();
  git(workDir, "init", "-q", "-b", "main");
  git(workDir, "config", "user.name", "t");
  git(workDir, "config", "user.email", "t@t");
  writeFileSync(path.join(workDir, "README.md"), "hello\n");
  git(workDir, "add", "-A");
  git(workDir, "commit", "-q", "-m", "init");
  git(workDir, "branch", "integration");
  resetSupervisorStateForTests();
  bootSupervisor();
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prevData === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prevData;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("invariant 1 — no authorisation, no change", () => {
  it("with none recorded the pass issues no git command and moves nothing; ADR-0109's merge-all behaves as before", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    const h = harness();
    const before = ref("integration");
    const r = await h.run();
    expect(r).toMatchObject({ merged: [], lock: "none" });
    expect(h.calls).toEqual([]);
    expect(h.gateRuns).toEqual([]);
    expect(ref("integration")).toBe(before);
    expect(existsSync(mergeLockPath(PROJECT))).toBe(false);
    // The user's click path (ADR-0109) is untouched: it still folds the branch into the CURRENT branch.
    const out = mergeAllWorktrees(workDir);
    expect(out.merged.map((m) => m.branch)).toEqual([tab.branch]);
    expect(readFileSync(path.join(workDir, "a.txt"), "utf8")).toBe("a\n");
  });

  it("a revoked authorisation is none again", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    expect(revokeMerge(PROJECT)).toBe(true);
    const h = harness();
    expect((await h.run()).merged).toEqual([]);
    expect(h.calls).toEqual([]);
  });
});

describe("a clean merge behind a passing gate (invariants 3, 6, 8)", () => {
  it("merges --no-ff in a scratch tree, runs the gate THERE, and fast-forwards target; the main checkout is untouched", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    authorise({ gate: "test -f a.txt" });
    const h = harness();
    const oldTip = ref("integration");
    const mainHead = git(workDir, "rev-parse", "HEAD");
    const r = await h.run();
    expect(r.merged).toEqual([tab.branch]);
    const newTip = ref("integration");
    expect(newTip).not.toBe(oldTip);
    // A merge commit whose first parent is the old tip and second the branch tip: --no-ff.
    expect(git(workDir, "rev-list", "--parents", "-n", "1", newTip).split(" ")).toEqual([newTip, oldTip, ref(tab.branch)]);
    expect(git(workDir, "show", `${newTip}:a.txt`)).toBe("a");
    // The gate ran in a scratch worktree under the data dir — never the user's checkout.
    expect(h.gateRuns).toHaveLength(1);
    expect(h.gateRuns[0]?.startsWith(path.join(dataDir, "merge-scratch", PROJECT))).toBe(true);
    expect(h.gateRuns[0]).not.toBe(workDir);
    // target is checked out nowhere: the main checkout stayed on main, at its own tip, with no file of the branch.
    expect(git(workDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(workDir, "rev-parse", "HEAD")).toBe(mainHead);
    expect(existsSync(path.join(workDir, "a.txt"))).toBe(false);
    // The scratch tree is gone, from disk and from git.
    expect(scratchTrees()).toEqual([]);
    expect(worktreePaths().some((p) => p.includes("merge-scratch"))).toBe(false);
    // The branch now derives `merged` (ADR-0103), and the record says what happened.
    expect(reconcileWorktrees(workDir).find((w) => w.branch === tab.branch)?.state).toBe("merged");
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ branch: tab.branch, status: "merged", prediction: "clean", gateExit: 0, commit: newTip });
    expect(existsSync(mergeLockPath(PROJECT))).toBe(false);
    expectSafeArgv(h);
  });

  it("moves no ref but target: every other branch keeps its tip", async () => {
    const a = makeTab("a", { "a.txt": "a\n" });
    const b = makeTab("b", { "b.txt": "b\n" });
    authorise();
    const refsBefore = git(workDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/");
    const h = harness();
    const r = await h.run();
    expect(r.merged.sort()).toEqual([a.branch, b.branch].sort());
    const refsAfter = git(workDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/");
    const changed = refsAfter.split("\n").filter((l) => !refsBefore.split("\n").includes(l));
    expect(changed.map((l) => l.split(" ")[0])).toEqual(["refs/heads/integration"]);
    expect(git(workDir, "tag", "--list")).toBe("");
    expect(git(workDir, "remote")).toBe("");
    // One branch, one gate run; one merge commit each (no octopus).
    expect(h.gateRuns).toHaveLength(2);
    expect(git(workDir, "rev-list", "--merges", "--count", "integration")).toBe("2");
    expectSafeArgv(h);
  });

  it("merges oldest first", async () => {
    // "zeta" is older but sorts after "alpha": age, not name, decides.
    makeTab("zeta", { "z.txt": "z\n" });
    await new Promise((r) => setTimeout(r, 15));
    makeTab("alpha", { "al.txt": "a\n" });
    authorise();
    const seen: Array<{ zeta: boolean; alpha: boolean }> = [];
    const h = harness({
      runGate: async (wd, cwd, command, opts) => {
        seen.push({ zeta: existsSync(path.join(cwd, "z.txt")), alpha: existsSync(path.join(cwd, "al.txt")) });
        return defaultPassDeps().runGate(wd, cwd, command, opts);
      },
    });
    await h.run();
    // zeta is older: its gate sees only zeta; alpha's gate sees both.
    expect(seen).toEqual([{ zeta: true, alpha: false }, { zeta: true, alpha: true }]);
  });
});

describe("a failing gate leaves target alone (invariants 3, 6)", () => {
  it("target is not moved, no scratch tree is left, and the failing output's tail is reported", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    authorise({ gate: "echo 'FAIL: 3 tests failed'; echo 'the tail line' 1>&2; exit 3" });
    const h = harness();
    const before = ref("integration");
    const r = await h.run();
    expect(r.merged).toEqual([]);
    expect(ref("integration")).toBe(before);
    expect(scratchTrees()).toEqual([]);
    expect(worktreePaths().some((p) => p.includes("merge-scratch"))).toBe(false);
    const rec = readMerge(PROJECT).branches[0];
    expect(rec).toMatchObject({ branch: tab.branch, status: "failed", code: "gate-failed", gateExit: 3, prediction: "clean" });
    expect(rec?.report).toContain("the tail line");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.text).toContain("FAIL: 3 tests failed");
    expect(reconcileWorktrees(workDir).find((w) => w.branch === tab.branch)?.state).toBe("ready");
    expectSafeArgv(h);
  });

  it("a gate that exceeds the user's timeout fails the same way and is killed", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise({ gate: "sleep 30", timeoutMs: 60_000 });
    const h = harness({ runGate: (wd, cwd, command, opts) => defaultPassDeps().runGate(wd, cwd, command, { ...opts, timeoutMs: 300 }) });
    const before = ref("integration");
    const t0 = Date.now();
    await h.run();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(ref("integration")).toBe(before);
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ status: "failed", code: "gate-failed" });
    expect(scratchTrees()).toEqual([]);
  });
});

describe("a predicted conflict is never resolved (invariant 5)", () => {
  it("skips the branch with the file list, spends no gate run and makes no scratch tree; the report goes to the tab", async () => {
    makeTab("a", { "README.md": "from a\n" });
    // target changed the same file: the two conflict.
    git(workDir, "checkout", "-q", "integration");
    writeFileSync(path.join(workDir, "README.md"), "from integration\n");
    git(workDir, "commit", "-qam", "integration edit");
    git(workDir, "checkout", "-q", "main");
    authorise();
    const h = harness();
    const before = ref("integration");
    const r = await h.run();
    expect(r.merged).toEqual([]);
    expect(ref("integration")).toBe(before);
    expect(h.gateRuns).toEqual([]);
    expect(h.calls.some((c) => c.includes("worktree") && c.includes("add"))).toBe(false);
    expect(scratchTrees()).toEqual([]);
    const rec = readMerge(PROJECT).branches[0];
    expect(rec).toMatchObject({ status: "skipped", code: "conflict", prediction: "conflict", reported: "recorded" });
    expect(rec?.report).toContain("README.md");
    expect(h.reports[0]?.text).toContain("README.md");
    expect(h.reports[0]?.text).toContain("never resolves a conflict");
    expectSafeArgv(h);
  });
});

describe("the tested commit must be the one that lands (invariant 7)", () => {
  it("target moved while the gate ran: the result is discarded and the branch retried against the new tip", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    authorise();
    let n = 0;
    let moved = "";
    const h = harness({
      runGate: async (wd, cwd, command, opts) => {
        n++;
        if (n === 1) {
          // Someone commits to target while the gate runs (plumbing: no checkout involved).
          const tree = git(workDir, "rev-parse", "integration^{tree}");
          moved = git(workDir, "commit-tree", tree, "-p", "integration", "-m", "moved under the gate");
          git(workDir, "update-ref", "refs/heads/integration", moved);
        }
        return defaultPassDeps().runGate(wd, cwd, command, opts);
      },
    });
    const r = await h.run();
    expect(r.merged).toEqual([tab.branch]);
    expect(n).toBe(2);
    const tip = ref("integration");
    // The landed commit was cut from the NEW tip: its first parent is the commit that moved target.
    expect(git(workDir, "rev-list", "--parents", "-n", "1", tip).split(" ")[1]).toBe(moved);
    expect(readLedger(PROJECT).some((l) => l.verb === "merge.retry" && l.reasonCode === "target-moved")).toBe(true);
    expect(scratchTrees()).toEqual([]);
    expectSafeArgv(h);
  });

  it("a target that keeps moving gives up after the bound and merges nothing", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    let gates = 0;
    const h = harness({
      runGate: async (wd, cwd, command, opts) => {
        gates++;
        const tree = git(workDir, "rev-parse", "integration^{tree}");
        git(workDir, "update-ref", "refs/heads/integration", git(workDir, "commit-tree", tree, "-p", "integration", "-m", `moved ${Math.random()}`));
        return defaultPassDeps().runGate(wd, cwd, command, opts);
      },
    });
    const r = await h.run();
    expect(r.merged).toEqual([]);
    expect(gates).toBe(3);
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ status: "skipped", code: "target-moving" });
    expect(scratchTrees()).toEqual([]);
  });
});

describe("the fast-forward waits for the user's checkout (invariant 8)", () => {
  it("target checked out in a dirty main checkout: the tested commit waits, says so, and lands by --ff-only once the tree is clean — never a reset", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    git(workDir, "checkout", "-q", "integration");
    writeFileSync(path.join(workDir, "README.md"), "user is editing\n");
    authorise();
    const h = harness();
    const oldTip = ref("integration");
    const r = await h.run();
    expect(r.merged).toEqual([]);
    expect(r.stopped).toBe("waiting");
    expect(ref("integration")).toBe(oldTip);
    expect(readFileSync(path.join(workDir, "README.md"), "utf8")).toBe("user is editing\n");
    const rec = readMerge(PROJECT).branches[0];
    expect(rec).toMatchObject({ branch: tab.branch, status: "waiting", code: "checkout-busy", gateExit: 0, prediction: "clean" });
    expect(rec?.reason).toContain("uncommitted changes");
    expect(rec?.commit).toMatch(/^[0-9a-f]{40}$/);
    // The tested commit is held by its scratch tree meanwhile.
    expect(scratchTrees()).toHaveLength(1);
    expect(h.gateRuns).toHaveLength(1);

    // The user commits their work: the next event lands the SAME tested commit, without a second gate run.
    git(workDir, "commit", "-qam", "user work");
    const userTip = ref("integration");
    // The user's own commit moved target: the tested commit is no longer the one that would land.
    const r2 = await h.run();
    expect(r2.merged).toEqual([tab.branch]);
    expect(h.gateRuns).toHaveLength(2);
    expect(git(workDir, "rev-list", "--parents", "-n", "1", ref("integration")).split(" ")[1]).toBe(userTip);
    expect(scratchTrees()).toEqual([]);
    expectSafeArgv(h);
  });

  it("when the user's tree is cleaned without moving target, the SAME tested commit is fast-forwarded in that checkout, whose files follow the tip", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    git(workDir, "checkout", "-q", "integration");
    writeFileSync(path.join(workDir, "README.md"), "scratch edit\n");
    authorise();
    const h = harness();
    await h.run();
    const waiting = readMerge(PROJECT).branches[0]?.commit as string;
    git(workDir, "checkout", "--", "README.md");
    const r = await h.run();
    expect(r.merged).toEqual([tab.branch]);
    expect(h.gateRuns).toHaveLength(1);
    expect(ref("integration")).toBe(waiting);
    expect(git(workDir, "rev-parse", "HEAD")).toBe(waiting);
    expect(readFileSync(path.join(workDir, "a.txt"), "utf8")).toBe("a\n");
    expect(git(workDir, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(h.calls.some((c) => c.includes("--ff-only"))).toBe(true);
    expect(h.calls.some((c) => c.includes("reset"))).toBe(false);
    expect(h.calls.some((c) => c[0] === "update-ref")).toBe(false);
    expect(scratchTrees()).toEqual([]);
    expectSafeArgv(h);
  });

  it("a live turn in the shared checkout makes it wait too (ADR-0102)", async () => {
    makeTab("a", { "a.txt": "a\n" });
    git(workDir, "checkout", "-q", "integration");
    authorise();
    let busy: string | null = "a turn is running in the shared checkout (tab abcd1234, ADR-0102)";
    const h = harness({ checkoutBusy: () => busy });
    const oldTip = ref("integration");
    expect((await h.run()).stopped).toBe("waiting");
    expect(ref("integration")).toBe(oldTip);
    expect(readMerge(PROJECT).branches[0]?.reason).toContain("shared checkout");
    busy = null;
    expect((await h.run()).merged).toHaveLength(1);
    expect(git(workDir, "rev-parse", "HEAD")).toBe(ref("integration"));
  });

  it("a clean main checkout holding target is fast-forwarded in place: no update-ref under a checked-out branch", async () => {
    makeTab("a", { "a.txt": "a\n" });
    git(workDir, "checkout", "-q", "integration");
    authorise();
    const h = harness();
    expect((await h.run()).merged).toHaveLength(1);
    expect(git(workDir, "rev-parse", "HEAD")).toBe(ref("integration"));
    expect(existsSync(path.join(workDir, "a.txt"))).toBe(true);
    expect(h.calls.some((c) => c[0] === "update-ref")).toBe(false);
  });

  it("revoking while a tested commit waits discards it and its scratch tree", async () => {
    makeTab("a", { "a.txt": "a\n" });
    git(workDir, "checkout", "-q", "integration");
    writeFileSync(path.join(workDir, "README.md"), "dirty\n");
    authorise();
    const h = harness();
    await h.run();
    expect(scratchTrees()).toHaveLength(1);
    revokeMerge(PROJECT);
    await h.run();
    expect(scratchTrees()).toEqual([]);
    expect(h.pass.waiting.size).toBe(0);
  });
});

describe("what a branch must be to merge (invariant 4) — one test each", () => {
  it("skips a branch whose tab did not close scope-met, and lists why", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" }, { scopeMet: false });
    authorise();
    const h = harness();
    const before = ref("integration");
    await h.run();
    expect(ref("integration")).toBe(before);
    expect(h.gateRuns).toEqual([]);
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ branch: tab.branch, status: "skipped", code: "scope-not-met" });
  });

  it("skips a branch whose worktree has uncommitted changes", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" }, { dirty: true });
    authorise();
    const h = harness();
    const before = ref("integration");
    await h.run();
    expect(ref("integration")).toBe(before);
    expect(h.gateRuns).toEqual([]);
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ branch: tab.branch, status: "skipped", code: "dirty" });
  });

  it("never touches a branch that is not `ready`: an open tab's branch is `session`, a merged one is `merged`", async () => {
    const open = makeTab("open", { "o.txt": "o\n" }, { closed: false });
    authorise();
    const h = harness();
    const before = ref("integration");
    await h.run();
    expect(ref("integration")).toBe(before);
    expect(h.gateRuns).toEqual([]);
    expect(readMerge(PROJECT).branches.find((b) => b.branch === open.branch)).toBeUndefined();
  });

  it("skips an implementer's branch and a tab with no session record: only a tab that closed its scope merges", async () => {
    const tab = makeTab("a", { "a.txt": "a\n" });
    metas.delete(tab.sessionId);
    authorise();
    const h = harness();
    await h.run();
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ status: "skipped", code: "no-session" });
    expect(h.gateRuns).toEqual([]);
  });

  it("merges into target ONLY: a branch named like the target is never merged, and no other branch is moved", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise({ target: "main" });
    const h = harness();
    const mainBefore = ref("main");
    const integrationBefore = ref("integration");
    // `main` is checked out in the user's checkout, clean: fast-forwarded there.
    expect((await h.run()).merged).toHaveLength(1);
    expect(ref("main")).not.toBe(mainBefore);
    expect(ref("integration")).toBe(integrationBefore);
    expectSafeArgv(h, "main");
  });
});

describe("the load wait: the guard command of milestone 5 (invariant 11)", () => {
  it("while the guard exits non-zero the pass waits: no scratch tree, no gate run, nothing moved; it records why", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    const h = harness({ guardCommand: () => "exit 1", runGuard: async () => ({ ok: false, detail: "exit 1" }) });
    const before = ref("integration");
    const r = await h.run();
    expect(r.stopped).toBe("guard");
    expect(ref("integration")).toBe(before);
    expect(h.gateRuns).toEqual([]);
    expect(h.calls.some((c) => c.includes("worktree") && c.includes("add"))).toBe(false);
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ status: "waiting", code: "guard" });
  });

  it("a guard that exits 0 lets the gate run; with none set there is no second mechanism", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    let asked = 0;
    const h = harness({ guardCommand: () => "true", runGuard: async () => {
        asked++;
        return { ok: true, detail: "" };
      },
    });
    expect((await h.run()).merged).toHaveLength(1);
    expect(asked).toBe(1);
  });
});

describe("the never-list is code (invariant 3)", () => {
  const ctx = { target: "integration", scratchRoot: "/data/merge-scratch/proj" };
  const sha = "a".repeat(40);
  it("allows exactly the pass's own commands", () => {
    for (const ok of [
      ["rev-parse", "--verify", "--quiet", "refs/heads/integration^{commit}"],
      ["merge-tree", "--write-tree", "--name-only", sha, sha],
      ["diff", "--name-only", `${sha}...${sha}`],
      ["worktree", "list", "--porcelain"],
      ["worktree", "prune"],
      ["worktree", "add", "--detach", "/data/merge-scratch/proj/x-1", sha],
      ["worktree", "remove", "--force", "/data/merge-scratch/proj/x-1"],
      ["-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "-m", "msg", sha],
      ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", sha],
      ["merge", "--abort"],
      ["update-ref", "refs/heads/integration", sha, sha],
    ]) {
      expect(argvViolation(ok, ctx), ok.join(" ")).toBeNull();
    }
  });

  it("refuses every push, tag, fetch, reset, branch delete, rebase, force and every ref but target", () => {
    for (const bad of [
      ["push", "origin", "integration"],
      ["push", "--force", "origin", "integration"],
      ["tag", "v1"],
      ["tag", "-a", "v1", "-m", "x"],
      ["fetch", "origin"],
      ["pull"],
      ["reset", "--hard", "origin/main"],
      ["reset", "--hard", "HEAD~1"],
      ["branch", "-D", "marvin/tab/a"],
      ["branch", "-d", "x"],
      ["branch", "-m", "integration", "x"],
      ["rebase", "main"],
      ["checkout", "-f", "main"],
      ["clean", "-fdx"],
      ["gc", "--prune=now"],
      ["commit", "--amend"],
      ["update-ref", "refs/heads/main", sha, sha],
      ["update-ref", "refs/tags/v1", sha, sha],
      ["update-ref", "-d", "refs/heads/integration"],
      ["update-ref", "refs/heads/integration", sha],
      ["merge", "--no-ff", "-m", "m", "marvin/tab/a"],
      ["merge", "main"],
      ["merge", "--squash", sha],
      ["worktree", "remove", "--force", "/home/user/project"],
      ["worktree", "remove", "--force", "/data/merge-scratch/proj/../../x"],
      ["worktree", "remove", "/data/merge-scratch/proj/x"],
      ["worktree", "add", "--detach", "/home/user/other", sha],
      ["worktree", "add", "-b", "newbranch", "/data/merge-scratch/proj/x", sha],
      ["-c", "core.sshCommand=evil", "merge", "--abort"],
      ["-c", "alias.x=!rm", "worktree", "prune"],
      ["config", "core.hooksPath", "/x"],
      ["remote", "add", "o", "u"],
      ["notes", "add"],
    ]) {
      expect(argvViolation(bad, ctx), bad.join(" ")).not.toBeNull();
    }
  });

  it("a refused argv is never executed: the pass's own git wrapper throws before exec", async () => {
    const h = harness();
    // @ts-expect-error — reaching the private wrapper on purpose
    await expect(h.pass.git({ target: "integration", scratchRoot: h.deps.scratchRoot(PROJECT) }, workDir, ["push", "origin", "main"])).rejects.toThrow(/may not run/);
    expect(h.calls).toEqual([]);
  });
});

describe("invariant 9 — scratch leftovers", () => {
  it("a scratch worktree a killed pass left behind is removed at the next pass start, and the user's checkout is left alone", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    const root = path.join(dataDir, "merge-scratch", PROJECT);
    mkdirSync(root, { recursive: true });
    const left = path.join(root, "leftover-1");
    git(workDir, "worktree", "add", "--detach", left, ref("integration"));
    expect(worktreePaths()).toContain(left);
    const h = harness();
    await h.run();
    expect(existsSync(left)).toBe(false);
    expect(worktreePaths()).not.toContain(left);
    expect(existsSync(workDir)).toBe(true);
    expect(readLedger(PROJECT).some((l) => l.verb === "merge.cleanup")).toBe(true);
    expectSafeArgv(h);
  });

  it("removes a half-made scratch directory git never heard of", async () => {
    authorise();
    const root = path.join(dataDir, "merge-scratch", PROJECT);
    mkdirSync(path.join(root, "half"), { recursive: true });
    writeFileSync(path.join(root, "half", "f"), "x");
    await harness().run();
    expect(existsSync(path.join(root, "half"))).toBe(false);
  });
});

describe("the lock — one pass at a time (invariant 9)", () => {
  it("a live pid in the lock means this process merges nothing, and says so in the ledger", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    // Another live process (the parent) holds the lock.
    expect(acquireMergeLock(PROJECT, { pid: process.ppid })).toBe("ours");
    const h = harness();
    const r = await h.run();
    expect(r.lock).toBe("held");
    expect(r.merged).toEqual([]);
    expect(h.gateRuns).toEqual([]);
    expect(readLedger(PROJECT).some((l) => l.reasonCode === "lock-held")).toBe(true);
    // And it did not release a lock that is not its own.
    expect(existsSync(mergeLockPath(PROJECT))).toBe(true);
  });

  it("a lock whose pid is gone is taken over, the pass runs, and the lock is released after", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    mkdirSync(path.dirname(mergeLockPath(PROJECT)), { recursive: true });
    writeFileSync(mergeLockPath(PROJECT), `${JSON.stringify({ pid: 2_147_483_000, at: new Date().toISOString() })}\n`);
    const h = harness({ isAlive: () => false });
    expect((await h.run()).merged).toHaveLength(1);
    expect(existsSync(mergeLockPath(PROJECT))).toBe(false);
  });
});

describe("revoking or expiring stops the pass before the next branch (invariant 9)", () => {
  it("a revoke between two branches leaves the second unmerged, and says why", async () => {
    const a = makeTab("a", { "a.txt": "a\n" });
    const b = makeTab("b", { "b.txt": "b\n" });
    // Their tabs are still open as far as the session record goes, so the pass closes `a`'s tab after its merge — and the user revokes right then.
    for (const t of [a, b]) {
      const m = metas.get(t.sessionId);
      if (m) m.closedAt = undefined;
    }
    authorise();
    const h = harness({
      closeTab: async (_p, _w, sessionId) => {
        revokeMerge(PROJECT);
        return { ok: true, message: `closed ${sessionId}` };
      },
    });
    const r = await h.run();
    expect(r.merged).toHaveLength(1);
    expect(r.stopped).toBe("revoked");
    expect(h.gateRuns).toHaveLength(1);
    expect(git(workDir, "rev-list", "--merges", "--count", "integration")).toBe("1");
    expect(readLedger(PROJECT).some((l) => l.verb === "merge.revoked")).toBe(true);
    expect(existsSync(mergeLockPath(PROJECT))).toBe(false);
  });

  it("a revoke DURING the gate kills the gate run, removes its scratch tree and moves nothing (the runner hears it on the event stream)", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise({ gate: "sleep 60" });
    const h = harness();
    const listeners: Array<(e: ProjectEvent) => void> = [];
    const runner = new MergeRunner(h.pass);
    runner.start(
      (l) => {
        listeners.push(l);
        return () => undefined;
      },
      () => [],
    );
    const before = ref("integration");
    const t0 = Date.now();
    const done = runner.kick(PROJECT);
    for (let i = 0; i < 200 && readMerge(PROJECT).running?.stage !== "gate"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(readMerge(PROJECT).running?.stage).toBe("gate");
    expect(scratchTrees()).toHaveLength(1);
    expect(revokeMerge(PROJECT)).toBe(true);
    // revokeMerge announced on the real stream; here the test is the stream.
    for (const l of listeners) l({ event: "supervisor.merge", data: { projectId: PROJECT, change: "revoked" } });
    const r = await done;
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r?.merged).toEqual([]);
    expect(r?.stopped).toBe("revoked");
    expect(ref("integration")).toBe(before);
    expect(scratchTrees()).toEqual([]);
    expect(worktreePaths().some((p) => p.includes("merge-scratch"))).toBe(false);
    expect(readMerge(PROJECT).running).toBeNull();
    expectSafeArgv(h);
  });

  it("an authorisation already past its expiry merges nothing; the end is recorded and ledgered once", async () => {
    makeTab("a", { "a.txt": "a\n" });
    approveMerge(PROJECT, proposal({ validForHours: 1 }), new Date(0));
    const h = harness();
    const before = ref("integration");
    const r = await h.run();
    expect(r.merged).toEqual([]);
    expect(h.gateRuns).toEqual([]);
    expect(ref("integration")).toBe(before);
    expect(readMerge(PROJECT).ended).toMatchObject({ why: "expired", target: "integration" });
    expect(readLedger(PROJECT).filter((l) => l.verb === "merge.expired")).toHaveLength(1);
    await h.run();
    expect(readLedger(PROJECT).filter((l) => l.verb === "merge.expired")).toHaveLength(1);
  });

  it("an expiry DURING the gate stops it: the gate is bounded by what is left, nothing moves, the scratch tree is removed", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise({ gate: "sleep 60", validForHours: 1 });
    const expiresAt = Date.parse(readMerge(PROJECT).authorisation?.expiresAt as string);
    const t0 = Date.now();
    // The clock the pass reads: 3 s before the expiry now, running at real speed.
    const h = harness({ now: () => expiresAt - 3000 + (Date.now() - t0) });
    const before = ref("integration");
    const r = await h.run();
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.merged).toEqual([]);
    expect(r.stopped).toBe("expired");
    expect(ref("integration")).toBe(before);
    expect(scratchTrees()).toEqual([]);
    expect(readMerge(PROJECT).branches[0]).toMatchObject({ code: "authorisation-ended" });
  });
});

describe("the runner is event-driven, one pass at a time", () => {
  const bus = () => {
    const listeners: Array<(e: ProjectEvent) => void> = [];
    return {
      subscribe: (l: (e: ProjectEvent) => void) => {
        listeners.push(l);
        return () => undefined;
      },
      emit: (e: ProjectEvent) => {
        for (const l of listeners) l(e);
      },
    };
  };

  it("a tab closing starts a pass; the pass's own bookkeeping does not", async () => {
    let passes = 0;
    const runner = new MergeRunner({
      run: async () => {
        passes++;
        return { merged: [], skipped: [], lock: "none" as const };
      },
    } as unknown as MergePass);
    const b = bus();
    runner.start(b.subscribe, () => []);
    expect(passes).toBe(0);
    for (const change of ["branch", "running", "held"]) b.emit({ event: "supervisor.merge", data: { projectId: PROJECT, change } });
    await new Promise((r) => setTimeout(r, 50));
    expect(passes).toBe(0);
    b.emit({ event: "session.closed", data: { marvinSessionId: "s", projectId: PROJECT } });
    for (let i = 0; i < 100 && passes < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(passes).toBe(1);
    b.emit({ event: "supervisor.merge", data: { projectId: PROJECT, change: "approved" } });
    for (let i = 0; i < 100 && passes < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(passes).toBe(2);
    runner.stop();
  });

  it("a kick during a pass is coalesced into exactly one more pass; two kicks never run two passes at once", async () => {
    let active = 0;
    let maxActive = 0;
    let passes = 0;
    const runner = new MergeRunner({
      run: async () => {
        passes++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 60));
        active--;
        return { merged: [], skipped: [], lock: "ours" as const };
      },
    } as unknown as MergePass);
    const first = runner.kick(PROJECT);
    expect(await runner.kick(PROJECT)).toBeNull();
    expect(await runner.kick(PROJECT)).toBeNull();
    await first;
    expect(passes).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("a paused or off supervisor merges nothing", async () => {
    makeTab("a", { "a.txt": "a\n" });
    authorise();
    const h = harness({ supervisorRefusal: () => "the supervisor is paused" });
    const r = await h.run();
    expect(r).toMatchObject({ merged: [], stopped: "paused" });
    expect(h.calls).toEqual([]);
  });
});

describe("the lock is cleared at boot when its pid is gone", () => {
  it("clearStaleMergeLocks removes a dead pid's lock and leaves a live one's; boot runs it", () => {
    mkdirSync(path.dirname(mergeLockPath(PROJECT)), { recursive: true });
    writeFileSync(mergeLockPath(PROJECT), `${JSON.stringify({ pid: 2_147_483_000, at: new Date().toISOString() })}\n`);
    expect(clearStaleMergeLocks((pid) => pid === process.ppid)).toEqual([PROJECT]);
    expect(existsSync(mergeLockPath(PROJECT))).toBe(false);
    writeFileSync(mergeLockPath(PROJECT), `${JSON.stringify({ pid: process.ppid, at: new Date().toISOString() })}\n`);
    expect(clearStaleMergeLocks()).toEqual([]);
    expect(existsSync(mergeLockPath(PROJECT))).toBe(true);
    unlinkSync(mergeLockPath(PROJECT));
    // bootSupervisor clears a dead pid's lock too.
    writeFileSync(mergeLockPath(PROJECT), `${JSON.stringify({ pid: 2_147_483_000, at: new Date().toISOString() })}\n`);
    resetSupervisorStateForTests();
    bootSupervisor();
    expect(existsSync(mergeLockPath(PROJECT))).toBe(false);
  });
});
