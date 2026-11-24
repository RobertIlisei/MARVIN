// ADR-0130 addendum (2026-11-24) — the wait clock. `waitingOn.since` restarts
// whenever a tab re-arms the same wait; the stretch is what survives that.
// These pin the transitions (pure), the validation where the meta is read, and
// the meta round trip a sidecar restart must not lose.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readSessionMeta, sessionMetaPath, upsertSessionMeta } from "../src/session-meta";
import { endLiveTurn, markTurnFilesEdited, registerLiveTurn } from "../src/turn-registry";
import {
  isFileEditToolCall,
  markRestartRearmed,
  nextWaitStretch,
  readWaitStretch,
  settleWaitStretchAtTurnEnd,
  settleWaitStretchAtTurnStart,
  waitingSinceOf,
} from "../src/wait-stretch";

const T0 = "2026-11-24T20:00:00.000Z";
const T1 = "2026-11-24T20:05:00.000Z";
const T2 = "2026-11-24T20:09:00.000Z";

describe("nextWaitStretch — the rule", () => {
  it("a turn that ends with nothing pending clears the stretch", () => {
    expect(nextWaitStretch({ since: T0 }, { phase: "end", filesEdited: false, waitStart: null })).toBeUndefined();
  });

  it("a turn that only re-arms keeps the stretch and its start", () => {
    expect(nextWaitStretch({ since: T0 }, { phase: "end", filesEdited: false, waitStart: T2 })).toEqual({ since: T0 });
  });

  it("a turn that edited files starts a new stretch at the wait it armed, dropping the cause", () => {
    expect(nextWaitStretch({ since: T0, cause: "restart" }, { phase: "end", filesEdited: true, waitStart: T2 })).toEqual({ since: T2 });
  });

  it("the first turn that ends waiting starts the stretch", () => {
    expect(nextWaitStretch(undefined, { phase: "end", filesEdited: false, waitStart: T1 })).toEqual({ since: T1 });
  });

  it("a kept stretch keeps its cause and never starts after the wait it covers", () => {
    expect(nextWaitStretch({ since: T2, cause: "restart" }, { phase: "end", filesEdited: false, waitStart: T0 })).toEqual({ since: T0, cause: "restart" });
  });

  it("a person's or the supervisor's turn on a tab with nothing pending drops a stale stretch; machine turns and busy tabs keep it", () => {
    const prev = { since: T0 };
    expect(nextWaitStretch(prev, { phase: "start", kind: "human", pending: false })).toBeUndefined();
    expect(nextWaitStretch(prev, { phase: "start", kind: "machine", author: "supervisor", pending: false })).toBeUndefined();
    expect(nextWaitStretch(prev, { phase: "start", kind: "human", pending: true })).toEqual(prev);
    expect(nextWaitStretch(prev, { phase: "start", kind: "machine", pending: false })).toEqual(prev);
  });
});

describe("readWaitStretch — validated where read", () => {
  it("accepts a well-formed stretch and drops an unknown cause", () => {
    expect(readWaitStretch({ waitStretch: { since: T0, cause: "restart" } })).toEqual({ since: T0, cause: "restart" });
    expect(readWaitStretch({ waitStretch: { since: T0, cause: "bogus" } as never })).toEqual({ since: T0 });
  });
  it("refuses anything else", () => {
    expect(readWaitStretch(null)).toBeUndefined();
    expect(readWaitStretch({})).toBeUndefined();
    expect(readWaitStretch({ waitStretch: { since: "yesterday" } })).toBeUndefined();
    expect(readWaitStretch({ waitStretch: { since: 5 } as never })).toBeUndefined();
    expect(readWaitStretch({ waitStretch: "x" as never })).toBeUndefined();
  });
});

describe("waitingSinceOf", () => {
  it("is the earlier of the stretch and this wait; this wait's start without a stretch", () => {
    expect(waitingSinceOf({ since: T0 }, T1)).toBe(T0);
    expect(waitingSinceOf({ since: T2 }, T1)).toBe(T1);
    expect(waitingSinceOf(undefined, T1)).toBe(T1);
  });
});

describe("isFileEditToolCall", () => {
  it("is the file-edit tools and nothing else — a Bash call is never one", () => {
    for (const n of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) expect(isFileEditToolCall(n)).toBe(true);
    for (const n of ["Bash", "Read", "mcp__marvin-control__run_background_job", "mcp__marvin-control__schedule_wakeup", "TodoWrite"]) expect(isFileEditToolCall(n)).toBe(false);
  });
});

describe("the stretch on the session meta", () => {
  let dataDir: string;
  const projectId = "ws-proj";
  const posture = { model: "m", advisorModel: null, personality: "ultron" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "marvin-wait-stretch-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    upsertSessionMeta(projectId, "s1", { workDir: dataDir, tree: { mode: "shared" }, posture });
  });
  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("survives a read from disk, which is what a sidecar restart does", () => {
    settleWaitStretchAtTurnEnd(projectId, "s1", { filesEdited: false, waitStart: T0 });
    settleWaitStretchAtTurnEnd(projectId, "s1", { filesEdited: false, waitStart: T2 });
    expect(readWaitStretch(readSessionMeta(projectId, "s1"))).toEqual({ since: T0 });
    settleWaitStretchAtTurnEnd(projectId, "s1", { filesEdited: true, waitStart: T2 });
    expect(readWaitStretch(readSessionMeta(projectId, "s1"))).toEqual({ since: T2 });
    settleWaitStretchAtTurnEnd(projectId, "s1", { filesEdited: false, waitStart: null });
    expect(readSessionMeta(projectId, "s1")?.waitStretch).toBeUndefined();
  });

  it("a person's turn on an idle tab clears what a cancelled job left behind", () => {
    settleWaitStretchAtTurnEnd(projectId, "s1", { filesEdited: false, waitStart: T0 });
    settleWaitStretchAtTurnStart(projectId, "s1", { kind: "human", pending: false });
    expect(readSessionMeta(projectId, "s1")?.waitStretch).toBeUndefined();
  });

  it("restart recovery marks the stretch, continuing an existing one and starting one otherwise", () => {
    markRestartRearmed(projectId, "s1", T1);
    expect(readWaitStretch(readSessionMeta(projectId, "s1"))).toEqual({ since: T1, cause: "restart" });
    settleWaitStretchAtTurnEnd(projectId, "s1", { filesEdited: false, waitStart: T2 });
    expect(readWaitStretch(readSessionMeta(projectId, "s1"))).toEqual({ since: T1, cause: "restart" });
    markRestartRearmed(projectId, "s1", T0);
    expect(readWaitStretch(readSessionMeta(projectId, "s1"))).toEqual({ since: T0, cause: "restart" });
  });

  it("a session without a meta is left without one", () => {
    markRestartRearmed(projectId, "nobody", T1);
    expect(readSessionMeta(projectId, "nobody")).toBeNull();
  });

  it("a corrupt value on disk reads as no stretch, never as a crash", () => {
    const p = sessionMetaPath(projectId, "s1");
    const meta = readSessionMeta(projectId, "s1")!;
    writeFileSync(p, JSON.stringify({ ...meta, waitStretch: { since: { x: 1 }, cause: 7 } }));
    expect(readWaitStretch(readSessionMeta(projectId, "s1"))).toBeUndefined();
  });
});

describe("the live turn's filesEdited flag", () => {
  it("is set by markTurnFilesEdited, independent of `mutated`, and not on an ended turn or an unknown session", () => {
    const t = registerLiveTurn({ turnId: "fe1", marvinSessionId: "fe-s1", projectId: "p", kind: "machine" });
    expect(t.filesEdited).toBe(false);
    expect(() => markTurnFilesEdited("no-such-session")).not.toThrow();
    markTurnFilesEdited("fe-s1");
    expect(t.filesEdited).toBe(true);
    expect(t.mutated).toBe(false);
    const u = registerLiveTurn({ turnId: "fe2", marvinSessionId: "fe-s2", projectId: "p", kind: "machine" });
    endLiveTurn(u, { event: "turn.completed", data: {} });
    markTurnFilesEdited("fe-s2");
    expect(u.filesEdited).toBe(false);
  });
});
