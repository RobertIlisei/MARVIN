import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readNotices } from "../src/notices";
import type { SessionWatchRow } from "../src/session-watch";
import { actionsFor, listInbox } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { defaultInboxPerform } from "../src/supervisor-inbox-perform";
import { readLedger } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext } from "../src/supervisor-mcp";
import { ActionLimiter, evaluateNotice } from "../src/supervisor-policy";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";

// ADR-0131 decisions 1 and 2 — `post_notice`: project-wide, allowed when some
// open tab is delegated at answer-questions or above, in the nudges category;
// a word-list match is a card (never a refusal); a secret is refused; every
// outcome is ledgered.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const POSTURE = { model: "claude-opus-5-5", advisorModel: null, thinkingMode: "high", permissionStrategy: "auto" as const, mode: "agent" as const, personality: "marvin" as const };
const row = (id: string) => ({ marvinSessionId: id, projectId: "proj", state: "idle", pending: [], plan: null, title: id, posture: POSTURE }) as unknown as SessionWatchRow;

let rows: SessionWatchRow[];
const verbs = () =>
  createSupervisorVerbs({
    projectId: "proj",
    workDir,
    wakeId: "wake-1",
    wake: { acts: 0 },
    limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
    deps: { listRows: async () => rows },
  } as unknown as VerbContext);
const noticeLines = () => readLedger("proj").filter((e) => e.verb === "post_notice");

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-notice-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-notice-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  rows = [row("tab-1")];
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("evaluateNotice", () => {
  const base = { mode: "autonomous" as const, anyDelegated: true, secret: false, heuristic: null };
  it("refuses when the supervisor is off, no tab is delegated high enough, or the text is a secret", () => {
    expect(evaluateNotice({ ...base, mode: "off" })).toMatchObject({ decision: "refuse", reasonCode: "off" });
    expect(evaluateNotice({ ...base, anyDelegated: false })).toMatchObject({ decision: "refuse", reasonCode: "delegation" });
    expect(evaluateNotice({ ...base, secret: true })).toMatchObject({ decision: "refuse", reasonCode: "secret" });
  });
  it("escalates, never refuses, a word-list match", () => {
    expect(evaluateNotice({ ...base, heuristic: "release" })).toMatchObject({ decision: "escalate", reasonCode: "heuristic", heuristic: "release" });
  });
  it("acts when autonomous, proposes in shadow, and a message wake in shadow is a card", () => {
    expect(evaluateNotice(base).decision).toBe("act");
    expect(evaluateNotice({ ...base, mode: "shadow" }).decision).toBe("propose");
    expect(evaluateNotice({ ...base, mode: "shadow", messageWake: true })).toMatchObject({ decision: "escalate", reasonCode: "shadow" });
  });
});

describe("post_notice", () => {
  it("in shadow: proposes, posts nothing, ledgers", async () => {
    act({ action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
    expect(await verbs().post_notice({ text: "the test machine is at a new address" })).toMatch(/shadow/i);
    expect(readNotices(workDir)).toEqual([]);
    expect(noticeLines()).toHaveLength(1);
    expect(noticeLines()[0]).toMatchObject({ decision: "propose" });
  });

  it("autonomous: posts a supervisor notice to the project root's store and ledgers it", async () => {
    act({ action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    expect(await verbs().post_notice({ text: "the test machine is at a new address", ttlHours: 2 })).toMatch(/Posted/);
    const [n] = readNotices(workDir);
    expect(n).toMatchObject({ author: "supervisor", text: "the test machine is at a new address" });
    expect(noticeLines()[0]).toMatchObject({ decision: "act", mode: "autonomous" });
  });

  it("refused when no open tab is delegated at answer-questions or above (observe is not enough)", async () => {
    act({ action: "start", delegations: [{ sessionId: "tab-1", level: "observe" }] });
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    expect(await verbs().post_notice({ text: "fine" })).toMatch(/Refused/);
    expect(readNotices(workDir)).toEqual([]);
    expect(noticeLines()[0]).toMatchObject({ decision: "refuse", reasonCode: "delegation" });
  });

  it("refused when the supervisor is off", async () => {
    expect(await verbs().post_notice({ text: "fine" })).toMatch(/Refused/);
    expect(noticeLines()[0]).toMatchObject({ decision: "refuse" });
  });

  it("refuses a malformed notice (empty, over-long, bad lifetime) and a secret-shaped one", async () => {
    act({ action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    expect(await verbs().post_notice({ text: "  " })).toMatch(/Refused/);
    expect(await verbs().post_notice({ text: "x".repeat(401) })).toMatch(/Refused/);
    expect(await verbs().post_notice({ text: "ok", ttlHours: 1000 })).toMatch(/Refused/);
    expect(await verbs().post_notice({ text: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" })).toMatch(/Refused/);
    expect(readNotices(workDir)).toEqual([]);
    expect(noticeLines().map((l) => l.decision)).toEqual(["refuse", "refuse", "refuse", "refuse"]);
  });

  it("a word-list match escalates to an inbox card, posts nothing, and the user's click posts it", async () => {
    act({ action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] });
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    const reply = await verbs().post_notice({ text: "append-only release files are now union-merged" });
    expect(reply).toMatch(/Escalated/);
    expect(readNotices(workDir)).toEqual([]);
    expect(noticeLines()[0]).toMatchObject({ decision: "escalate", reasonCode: "heuristic" });
    const [item] = listInbox("proj");
    expect(item).toMatchObject({ state: "open", act: { type: "notice" } });
    expect(item && actionsFor(item).map((a) => a.id)).toEqual(["perform", "dismiss"]);
    const perform = defaultInboxPerform("proj", workDir, token()) as InboxPerform;
    const r = await actOnInboxItem("proj", { id: (item as { id: string }).id, actionId: "perform" }, perform);
    expect(r.ok).toBe(true);
    expect(readNotices(workDir)).toMatchObject([{ author: "supervisor", text: "append-only release files are now union-merged" }]);
  });
});
