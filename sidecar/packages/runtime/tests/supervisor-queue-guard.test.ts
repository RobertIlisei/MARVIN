import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listInbox } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { defaultInboxPerform } from "../src/supervisor-inbox-perform";
import { readLedger } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext } from "../src/supervisor-mcp";
import { ActionLimiter } from "../src/supervisor-policy";
import { approveEntries, type QueueEntryProposal, readQueue, setGuard } from "../src/supervisor-queue";
import { runGuardCommand } from "../src/supervisor-queue-guard";
import { type OpenerDeps, QueueOpener } from "../src/supervisor-queue-opener";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";

// ADR-0133 decision 1 — the guard command is the user's: stored with the queue
// in the supervisor dir, set only through a card showing it in full, run with
// the env map's rules and a timeout, and a non-zero exit holds and is ledgered.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "plan" as const, personality: "marvin" as const };
const proposal = (id: string): QueueEntryProposal => ({ id, title: id, brief: id, posture: POSTURE, wider: [] });
const writeWorktreeJson = (body: unknown) => {
  mkdirSync(path.join(workDir, ".marvin"), { recursive: true });
  writeFileSync(path.join(workDir, ".marvin", "worktree.json"), JSON.stringify(body));
};
const verbs = () =>
  createSupervisorVerbs({
    projectId: "proj",
    workDir,
    wakeId: "w",
    wake: { acts: 0 },
    limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
    deps: { listRows: async () => [] },
  } as unknown as VerbContext);

function deps(over: Partial<OpenerDeps> = {}) {
  const opened: string[] = [];
  const d: OpenerDeps = {
    pid: 1,
    isAlive: () => true,
    now: () => Date.now(),
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
  return { d, opened };
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-guard-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-guard-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  act({ action: "start" });
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("runGuardCommand", () => {
  it("exit 0 passes; a non-zero exit fails with its code; it runs in the project root", async () => {
    expect(await runGuardCommand(workDir, "exit 0")).toEqual({ ok: true });
    expect(await runGuardCommand(workDir, "exit 3")).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect(await runGuardCommand(workDir, `test "$(pwd -P)" = "${realpathSync(workDir)}"`)).toEqual({ ok: true });
  });

  it("a command that outlives the timeout is killed and fails as timed out", async () => {
    const t0 = Date.now();
    const r = await runGuardCommand(workDir, "sleep 30", { timeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, exitCode: null, timedOut: true });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it("runs with the env map's rules: a project variable is set, a reserved one (PATH) is refused", async () => {
    writeWorktreeJson({ env: { QUEUE_PROBE: "yes", PATH: "/nonexistent", NODE_OPTIONS: "--evil", MARVIN_X: "1" } });
    expect(await runGuardCommand(workDir, 'test "$QUEUE_PROBE" = yes')).toEqual({ ok: true });
    expect(await runGuardCommand(workDir, 'test "$PATH" != /nonexistent && test -z "$MARVIN_X" && test "$NODE_OPTIONS" != --evil')).toEqual({ ok: true });
  });

  it("a command that cannot start is a failure, not an exception", async () => {
    expect(await runGuardCommand(path.join(workDir, "missing-dir"), "true")).toMatchObject({ ok: false, exitCode: null });
  });
});

describe("the opener and the guard", () => {
  it("a non-zero exit holds the queue, says why on the entry, in guardLast and in the ledger", async () => {
    approveEntries("proj", [proposal("A")]);
    setGuard("proj", "exit 7");
    const { d, opened } = deps({ runGuard: (_p, w, c) => runGuardCommand(w, c) });
    await new QueueOpener(d).kick("proj");
    expect(opened).toEqual([]);
    expect(readQueue("proj").entries[0]?.blocked).toMatchObject({ code: "guard", reason: "the guard command exited 7" });
    expect(readQueue("proj").guardLast).toMatchObject({ ok: false, exitCode: 7, timedOut: false });
    expect(readLedger("proj").filter((l) => l.verb === "queue.guard")).toMatchObject([{ decision: "refuse", reasonCode: "guard", reason: expect.stringContaining("exited 7") }]);
  });

  it("exit 0 lets it open, and the guard ran before the tab was opened", async () => {
    approveEntries("proj", [proposal("A")]);
    setGuard("proj", "exit 0");
    const order: string[] = [];
    const { d } = deps({
      runGuard: async () => {
        order.push("guard");
        return { ok: true };
      },
      open: async (_p, _w, e) => {
        order.push("open");
        return { ok: true, marvinSessionId: `tab-${e.id}`, branch: "b" };
      },
    });
    await new QueueOpener(d).kick("proj");
    expect(order).toEqual(["guard", "open"]);
    expect(readQueue("proj").guardLast).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("a timed-out guard holds with that said", async () => {
    approveEntries("proj", [proposal("A")]);
    setGuard("proj", "sleep 30");
    const { d, opened } = deps({ runGuard: (_p, w, c) => runGuardCommand(w, c, { timeoutMs: 100 }) });
    await new QueueOpener(d).kick("proj");
    expect(opened).toEqual([]);
    expect(readQueue("proj").entries[0]?.blocked?.reason).toBe("the guard command timed out");
  });

  it("with no guard set, nothing is run", async () => {
    approveEntries("proj", [proposal("A")]);
    let ran = false;
    const { d, opened } = deps({
      runGuard: async () => {
        ran = true;
        return { ok: true };
      },
    });
    await new QueueOpener(d).kick("proj");
    expect(ran).toBe(false);
    expect(opened).toEqual(["A"]);
  });

  it("never reads a command from .marvin/worktree.json or any file in the project", async () => {
    writeWorktreeJson({ openGuard: "exit 1", guard: "exit 1", guardCommand: "exit 1" });
    writeFileSync(path.join(workDir, "guard.sh"), "exit 1");
    approveEntries("proj", [proposal("A")]);
    // The real runner, no guard in the queue: the entry opens.
    const { d, opened } = deps({ runGuard: (_p, w, c) => runGuardCommand(w, c) });
    await new QueueOpener(d).kick("proj");
    expect(opened).toEqual(["A"]);
    expect(readQueue("proj").guard).toBeNull();
  });
});

describe("setting or changing the command takes the user's click on a card showing it in full", () => {
  const performer = () => defaultInboxPerform("proj", workDir, token()) as InboxPerform;

  it("the supervisor proposes: a card with the whole command; the stored guard is unchanged; a changed text does not run until approved again", async () => {
    setGuard("proj", "echo old");
    const long = `ssh runner 'true' # ${"y".repeat(400)}`;
    expect(await verbs().propose_guard({ command: long })).toMatch(/user's to set/);
    expect(readQueue("proj").guard?.command).toBe("echo old");
    const [item] = listInbox("proj");
    expect(item).toMatchObject({ kind: "queue", queue: { kind: "guard", command: long, previous: "echo old" } });
    expect(item?.rawAct?.summary).toContain(long);

    // The old, approved command keeps running; the new one has not been approved.
    approveEntries("proj", [proposal("A")]);
    const ran: string[] = [];
    const { d } = deps({
      runGuard: async (_p, _w, c) => {
        ran.push(c);
        return { ok: false, exitCode: 1, timedOut: false, detail: "" };
      },
    });
    await new QueueOpener(d).kick("proj");
    expect(ran).toEqual(["echo old"]);

    // The click sets it; the next run uses the new text.
    expect((await actOnInboxItem("proj", { id: (item as { id: string }).id, actionId: "approve" }, performer())).ok).toBe(true);
    expect(readQueue("proj").guard).toMatchObject({ command: long, approvedBy: "user" });
    await new QueueOpener(d).kick("proj");
    expect(ran).toEqual(["echo old", long]);
  });

  it("proposing the command that is already approved is refused; a secret or an empty one too; off is refused", async () => {
    setGuard("proj", "echo same");
    expect(await verbs().propose_guard({ command: "echo same" })).toMatch(/Refused/);
    expect(await verbs().propose_guard({ command: "  " })).toMatch(/Refused/);
    expect(await verbs().propose_guard({ command: "curl -H 'k: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' x" })).toMatch(/Refused/);
    act({ action: "stop" });
    expect(await verbs().propose_guard({ command: "echo other" })).toMatch(/Refused/);
    expect(listInbox("proj")).toEqual([]);
    expect(readQueue("proj").guard?.command).toBe("echo same");
  });

  it("an unapproved guard line in queue.json (no approvedBy 'user') is not a guard", () => {
    approveEntries("proj", [proposal("A")]);
    const q = readQueue("proj");
    expect(q.guard).toBeNull();
  });
});
