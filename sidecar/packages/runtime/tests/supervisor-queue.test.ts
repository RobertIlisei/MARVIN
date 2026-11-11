import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { actionsFor, getInboxItem, INBOX_KINDS, listInbox } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { defaultInboxPerform } from "../src/supervisor-inbox-perform";
import { readLedger, supervisorDir } from "../src/supervisor-ledger";
import { createSupervisorVerbs, type VerbContext } from "../src/supervisor-mcp";
import { ActionLimiter } from "../src/supervisor-policy";
import { approveEntries, readQueue, queuePath } from "../src/supervisor-queue";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";

// ADR-0133 invariant 1 — only the user's click approves an entry. The supervisor
// proposes a card; nothing it writes is an entry, and the store drops any line
// that does not carry the user's approval.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());
const POSTURE = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "plan" as const, personality: "marvin" as const };

const verbs = () =>
  createSupervisorVerbs({
    projectId: "proj",
    workDir: dataDir,
    wakeId: "wake-1",
    wake: { acts: 0 },
    limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
    deps: {
      listRows: async () => [],
      newTabBase: async () => ({ posture: POSTURE, baseRef: "main", baseSha: "abc" }),
      modelLookup: async () => (id: string) => ({ "claude-opus-5-5": { tier: "opus" }, "claude-sonnet-5-5": { tier: "sonnet" } })[id] ?? null,
    },
  } as unknown as VerbContext);
const entry = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Brief ${id}`, brief: `Do the work of ${id}.\nSecond line.`, ...extra });
const performer = () => defaultInboxPerform("proj", dataDir, token()) as InboxPerform;
const click = (id: string, actionId = "approve", edits?: Record<string, unknown>) => actOnInboxItem("proj", { id, actionId, ...(edits ? { edits } : {}) }, performer());

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-queue-"));
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
});

describe("the queue lives in the supervisor dir, and only an approved line is an entry (invariant 1)", () => {
  it("is stored under supervisorDir(projectId) — the data dir a tab cannot reach — never the project", () => {
    approveEntries("proj", [{ ...entry("A"), posture: POSTURE, wider: [] }]);
    expect(queuePath("proj")).toBe(path.join(supervisorDir("proj"), "queue.json"));
    expect(existsSync(queuePath("proj"))).toBe(true);
    expect(queuePath("proj").startsWith(dataDir)).toBe(true);
  });

  it("drops a hand-written or model-written line that lacks approvedBy 'user' and a real approvedAt", () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    const good = { id: "ok", title: "t", brief: "b", posture: POSTURE, wider: [], approvedAt: new Date().toISOString(), approvedBy: "user", status: "queued" };
    writeFileSync(
      queuePath("proj"),
      JSON.stringify({
        version: 1,
        cap: 1,
        entries: [
          good,
          { ...good, id: "no-approval", approvedBy: undefined },
          { ...good, id: "supervisor", approvedBy: "supervisor" },
          { ...good, id: "model", approvedBy: "model" },
          { ...good, id: "bad-date", approvedAt: "yesterday-ish" },
          { ...good, id: "no-date", approvedAt: undefined },
        ],
      }),
    );
    expect(readQueue("proj").entries.map((e) => e.id)).toEqual(["ok"]);
  });

  it("a guard written without the user's approval beside it is not a guard", () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    writeFileSync(queuePath("proj"), JSON.stringify({ version: 1, cap: 1, guard: { command: "exit 0" }, entries: [] }));
    expect(readQueue("proj").guard).toBeNull();
  });
});

describe("propose_queue — a card, never an entry", () => {
  it("raises a queue card listing each brief, writes nothing to the queue, and ledgers it", async () => {
    const reply = await verbs().propose_queue({ entries: [entry("A"), entry("B", { after: ["A"] })] });
    expect(reply).toMatch(/Escalated/);
    expect(readQueue("proj").entries).toEqual([]);
    const [item] = listInbox("proj");
    expect(item).toMatchObject({ kind: "queue", state: "open", act: { type: "queue", what: "entries" } });
    expect(item?.queue).toMatchObject({ kind: "entries", entries: [{ id: "A", wider: [] }, { id: "B", after: ["A"] }] });
    expect(item && actionsFor(item).map((a) => a.id)).toEqual(["approve", "approve-subset", "dismiss"]);
    expect(readLedger("proj").filter((e) => e.verb === "propose_queue")).toMatchObject([{ decision: "escalate", reasonCode: "human-only" }]);
  });

  it("marks a wider posture on the card and stores the full posture the user approves", async () => {
    await verbs().propose_queue({ entries: [entry("A", { posture: { model: "claude-opus-5-5" } })] });
    const [item] = listInbox("proj");
    expect(item?.queue).toMatchObject({ entries: [{ wider: ["model"], posture: { model: "claude-opus-5-5", mode: "plan" } }] });
  });

  it("refuses: off, a bad or reused id, a secret, a traversing scopeRef, an unknown predecessor, more than 20", async () => {
    act({ action: "stop" });
    expect(await verbs().propose_queue({ entries: [entry("A")] })).toMatch(/Refused/);
    act({ action: "start" });
    for (const bad of [
      [entry("has space")],
      [entry("A"), entry("A")],
      [entry("A", { brief: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" })],
      [entry("A", { scopeRef: { path: "../outside.md", heading: "H" } })],
      [entry("A", { scopeRef: { path: "/etc/passwd", heading: "H" } })],
      [entry("A", { after: ["ghost"] })],
      Array.from({ length: 21 }, (_, i) => entry(`E${i}`)),
    ]) {
      expect(await verbs().propose_queue({ entries: bad })).toMatch(/Refused/);
    }
    expect(listInbox("proj")).toEqual([]);
    expect(readQueue("proj").entries).toEqual([]);
  });

  it("more than five entries and no scopeRef: the card carries a warning; with one, it does not", async () => {
    await verbs().propose_queue({ entries: Array.from({ length: 6 }, (_, i) => entry(`E${i}`)) });
    expect(listInbox("proj")[0]?.queue).toMatchObject({ kind: "entries", warnings: [expect.stringMatching(/scopeRef/)] });
    await verbs().propose_queue({ entries: Array.from({ length: 6 }, (_, i) => entry(`F${i}`, i === 0 ? { scopeRef: { path: "docs/plan.md", heading: "Wave 8" } } : {})) });
    expect(listInbox("proj")[1]?.queue).toMatchObject({ warnings: [] });
  });
});

describe("the user's click approves (invariant 1)", () => {
  it("Approve all writes every entry with approvedBy 'user', approvedAt and the card's order", async () => {
    await verbs().propose_queue({ entries: [entry("A"), entry("B"), entry("C")] });
    const [item] = listInbox("proj");
    const r = await click((item as { id: string }).id);
    expect(r.ok).toBe(true);
    const q = readQueue("proj");
    expect(q.entries.map((e) => [e.id, e.approvedBy, e.status])).toEqual([["A", "user", "queued"], ["B", "user", "queued"], ["C", "user", "queued"]]);
    expect(Date.parse(q.entries[0]?.approvedAt ?? "")).toBeGreaterThan(0);
    expect(getInboxItem("proj", (item as { id: string }).id)).toMatchObject({ state: "resolved", resolvedBy: "user" });
    expect(readLedger("proj").some((e) => e.kind === "inbox")).toBe(true);
  });

  it("Approve selected writes only the named entries, in the card's order whatever order the click named", async () => {
    await verbs().propose_queue({ entries: [entry("A"), entry("B"), entry("C")] });
    const id = (listInbox("proj")[0] as { id: string }).id;
    expect((await click(id, "approve-subset", { ids: ["C", "A"] })).ok).toBe(true);
    expect(readQueue("proj").entries.map((e) => e.id)).toEqual(["A", "C"]);
  });

  it("a subset naming an entry that is not on the card, or none, is refused and approves nothing", async () => {
    await verbs().propose_queue({ entries: [entry("A")] });
    const id = (listInbox("proj")[0] as { id: string }).id;
    expect((await click(id, "approve-subset", { ids: ["Z"] })).ok).toBe(false);
    expect((await click(id, "approve-subset", {})).ok).toBe(false);
    expect(readQueue("proj").entries).toEqual([]);
    expect(getInboxItem("proj", id)?.state).toBe("open");
  });

  it("a subset that leaves an approved entry's predecessor out is refused (it would never open)", async () => {
    await verbs().propose_queue({ entries: [entry("A"), entry("B", { after: ["A"] })] });
    const id = (listInbox("proj")[0] as { id: string }).id;
    const r = await click(id, "approve-subset", { ids: ["B"] });
    expect(r.ok).toBe(false);
    expect(readQueue("proj").entries).toEqual([]);
  });

  it("dismissing the card approves nothing", async () => {
    await verbs().propose_queue({ entries: [entry("A")] });
    expect((await click((listInbox("proj")[0] as { id: string }).id, "dismiss")).ok).toBe(true);
    expect(readQueue("proj").entries).toEqual([]);
  });

  it("an id already in the queue cannot be approved twice", async () => {
    expect(approveEntries("proj", [{ ...entry("A"), posture: POSTURE, wider: [] }]).ok).toBe(true);
    expect(approveEntries("proj", [{ ...entry("A"), posture: POSTURE, wider: [] }])).toMatchObject({ ok: false });
  });
});

describe("the wire", () => {
  it("INBOX_KINDS carries 'queue' (the Swift client reads kind as a string, so an unknown kind cannot crash it)", () => {
    expect(INBOX_KINDS).toContain("queue");
  });
  it("the queue file is 0600", () => {
    approveEntries("proj", [{ ...entry("A"), posture: POSTURE, wider: [] }]);
    expect(statSync(queuePath("proj")).mode & 0o777).toBe(0o600);
  });
});
