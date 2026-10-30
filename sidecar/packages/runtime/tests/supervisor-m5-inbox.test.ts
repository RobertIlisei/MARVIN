import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPostureChange } from "../src/posture";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { defaultInboxPerform } from "../src/supervisor-inbox-perform";
import {
  addInboxItem,
  buildRawAct,
  getInboxItem,
  INBOX_ITEM_FIELDS,
  type InboxDraft,
  inboxPath,
  listInbox,
  openEscalationCounts,
  projectInboxItem,
  resolveInboxForConfirm,
  settleInboxItem,
  supersedeInbox,
} from "../src/supervisor-inbox";
import { appendLedgerEntry, readLedger } from "../src/supervisor-ledger";
import { GROUND_FIELDS, LEDGER_VIEW_FIELDS, projectGround, projectLedger } from "../src/supervisor-view";
import { type ProjectEvent, subscribeProjectEvents } from "../src/turn-registry";

// ADR-0127 milestone 5 — the escalation inbox (brief §10.2), the ledger's read
// shape (§10.5) and the full Ground (§10.6). The inbox is event-sourced beside
// the ledger: every change is a new line, the latest line per id is the item.

let dataDir: string;
let mainRoot: string;
const prev = process.env.MARVIN_DATA_DIR;
const P = "proj";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5i-data-"));
  mainRoot = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5i-main-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(mainRoot, { recursive: true, force: true });
});

const ctx = () => ({ mainRoot, charter: "Billing page. Postgres, not SQLite.", tabRoot: () => null, brief: () => null });

const QUESTION = {
  questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "the charter" }, { label: "SQLite" }] }],
};

/** One draft per `kind` the brief names, each carrying what that card reads. */
function drafts(): Record<string, InboxDraft> {
  const base = { modeAtCreation: "shadow" as const, wakeId: "wake-1", grounds: [{ kind: "charter" as const, ref: "Postgres, not SQLite", provenance: "strong" as const }] };
  return {
    question: {
      ...base,
      sessionId: "tab-1",
      kind: "question",
      escalatedBecause: { code: "heuristic", label: "The question names a human-only act" },
      heuristic: { matched: "merge" },
      question: QUESTION,
      linkedConfirm: { sessionId: "tab-1", turnId: "turn-1", toolUseId: "tu-q", raisingRule: "ask-user-question" },
      recommendation: { actionId: "answer", answer: { "Which database?": "Postgres" }, text: "The charter says Postgres." },
      act: { type: "answer", turnId: "turn-1", toolUseId: "tu-q", answers: { "Which database?": "Postgres" }, other: {} },
    },
    confirm: {
      ...base,
      sessionId: "tab-1",
      kind: "integration",
      escalatedBecause: { code: "human-only", label: "Pushing is the user's act", rule: "§4.1 push" },
      rawAct: buildRawAct("Bash", { command: "git push origin marvin/tab/x" }),
      linkedConfirm: { sessionId: "tab-1", turnId: "turn-1", toolUseId: "tu-c", raisingRule: "gated" },
      recommendation: { actionId: "allow", text: "The plan's last step is to push." },
      act: { type: "confirm", turnId: "turn-1", toolUseId: "tu-c" },
    },
    merge: {
      ...base,
      sessionId: null,
      kind: "integration",
      escalatedBecause: { code: "human-only", label: "Merging is the user's act", rule: "§4.1 merge" },
      rawAct: buildRawAct("worktrees.merge", { slugs: ["tab-x"] }),
      preview: { kind: "merge-tree", verdict: "behind", behind: 2, added: 10, removed: 3, conflictFiles: [] },
      recommendation: { actionId: "perform", text: "Clean, two behind." },
      act: { type: "worktrees", op: "merge", slugs: ["tab-x"] },
    },
    posture: {
      ...base,
      sessionId: "tab-1",
      kind: "posture-widen",
      escalatedBecause: { code: "human-only", label: "Widening a posture is the user's act", rule: "§4.5 posture" },
      rawAct: buildRawAct("set_posture", { marvinSessionId: "tab-1", posture: { permissionStrategy: "full" } }),
      postureChange: { from: { permissionStrategy: "auto" }, to: { permissionStrategy: "full" }, widenedDimensions: ["permissionStrategy"] },
      recommendation: { actionId: "perform", text: "It keeps asking." },
      act: { type: "posture", sessionId: "tab-1", patch: { permissionStrategy: "full" } },
    },
    close: {
      ...base,
      sessionId: "tab-1",
      kind: "scope",
      escalatedBecause: { code: "human-only", label: "Closing a tab is the user's act", rule: "§4.3 close" },
      rawAct: buildRawAct("close_session", { marvinSessionId: "tab-1", worktree: "keep" }),
      recommendation: { actionId: "perform", text: "Scope met; idle for 10 minutes." },
      act: { type: "close", sessionId: "tab-1", worktree: "keep" },
      dedupeKey: "close:tab-1:2026-10-30T10:00:00.000Z",
    },
    newTab: {
      ...base,
      sessionId: null,
      kind: "new-tab",
      escalatedBecause: { code: "human-only", label: "Opening a tab is the user's act", rule: "§4.7 topology" },
      rawAct: buildRawAct("new_session", { firstMessage: "Fix the flags page.", tree: "worktree" }),
      newTab: {
        firstMessage: "Fix the flags page.",
        tree: { baseRef: "main", baseSha: "abc123", mode: "worktree" },
        posture: { model: "claude-sonnet-5-5", modelLabel: "Sonnet 5.5", effort: "medium", strategy: "gated", mode: "plan" },
        wider: [],
        requestedBy: { kind: "user-message", ref: "msg-1", at: "2026-10-30T10:00:00.000Z" },
      },
      recommendation: { actionId: "open", text: "You asked for a tab for the flags page." },
      act: { type: "new-tab", requestId: "msg-1", posture: { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated", mode: "plan", personality: "marvin" }, grounds: [] },
    },
    guardrail: {
      ...base,
      grounds: [],
      sessionId: null,
      kind: "guardrail",
      escalatedBecause: { code: "budget", label: "Daily cap reached" },
      guardrail: { kind: "budget", detail: "$10.00 of $10", verb: "raise-cap" },
      act: { type: "guardrail", pause: "budget" },
    },
  };
}

describe("the inbox store", () => {
  it("adds an item as an open record, persisted 0600, listed oldest first", () => {
    const a = addInboxItem(P, drafts().question as InboxDraft);
    const b = addInboxItem(P, drafts().merge as InboxDraft);
    expect(a.state).toBe("open");
    expect(a.revision).toBe(1);
    expect(a.resolvedBy).toBeNull();
    expect(statSync(inboxPath(P)).mode & 0o777).toBe(0o600);
    expect(listInbox(P, { state: "open" }).map((i) => i.id)).toEqual([a.id, b.id]);
  });

  it("settles by appending, never rewriting: the item reads resolved, the old line is still on disk", () => {
    const a = addInboxItem(P, drafts().question as InboxDraft);
    const settled = settleInboxItem(P, a.id, { state: "resolved", resolvedBy: "user" });
    expect(settled?.revision).toBe(2);
    expect(getInboxItem(P, a.id)?.state).toBe("resolved");
    expect(listInbox(P, { state: "open" })).toEqual([]);
    expect(listInbox(P).length).toBe(1);
    // Settling again is a no-op, not a second resolution.
    expect(settleInboxItem(P, a.id, { state: "dismissed", resolvedBy: "user" })).toBeNull();
  });

  it("dedupes on a key across every state: a dismissed close item is not offered again for the same scope-met close", () => {
    const first = addInboxItem(P, drafts().close as InboxDraft);
    settleInboxItem(P, first.id, { state: "dismissed", resolvedBy: "user" });
    const second = addInboxItem(P, drafts().close as InboxDraft);
    expect(second.id).toBe(first.id);
    expect(listInbox(P).length).toBe(1);
  });

  it("a linked confirm answered anywhere resolves its item, by the tab", () => {
    const q = addInboxItem(P, drafts().question as InboxDraft);
    const other = addInboxItem(P, drafts().confirm as InboxDraft);
    expect(resolveInboxForConfirm(P, { toolUseId: "tu-q", answeredBy: "user" })).toBe(1);
    expect(getInboxItem(P, q.id)).toMatchObject({ state: "resolved", resolvedBy: "tab" });
    expect(getInboxItem(P, other.id)?.state).toBe("open");
    // A confirm that ended unanswered (timeout, turn unwound) expires its item.
    expect(resolveInboxForConfirm(P, { toolUseId: "tu-c" })).toBe(1);
    expect(getInboxItem(P, other.id)).toMatchObject({ state: "superseded", resolvedBy: "expired" });
  });

  it("supersedes by predicate", () => {
    const c = addInboxItem(P, drafts().close as InboxDraft);
    addInboxItem(P, drafts().question as InboxDraft);
    expect(supersedeInbox(P, (i) => i.kind === "scope" && i.sessionId === "tab-1")).toBe(1);
    expect(getInboxItem(P, c.id)?.state).toBe("superseded");
  });

  it("counts open escalations per tab and in total — the watch row's and the status's openEscalations", () => {
    addInboxItem(P, drafts().question as InboxDraft);
    addInboxItem(P, drafts().confirm as InboxDraft);
    addInboxItem(P, drafts().guardrail as InboxDraft);
    const counts = openEscalationCounts(P);
    expect(counts.total).toBe(3);
    expect(counts.byTab.get("tab-1")).toBe(2);
  });

  it("announces added, then resolved, on the project feed — ids only, never the raw act", () => {
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => {
      if (e.event === "supervisor.inbox") seen.push(e);
    });
    try {
      const a = addInboxItem(P, drafts().confirm as InboxDraft);
      resolveInboxForConfirm(P, { toolUseId: "tu-c", answeredBy: "user" });
      expect(seen.map((e) => (e.data as { change: string }).change)).toEqual(["added", "resolved"]);
      expect(seen[0]?.data).toMatchObject({ projectId: P, id: a.id, sessionId: "tab-1", kind: "integration" });
      expect(JSON.stringify(seen)).not.toContain("git push");
    } finally {
      off();
    }
  });
});

describe("the item as the brief reads it (§10.2)", () => {
  it("every field, for every kind", () => {
    for (const [name, d] of Object.entries(drafts())) {
      const item = projectInboxItem(addInboxItem(P, d as InboxDraft), ctx(), listInbox(P));
      for (const f of INBOX_ITEM_FIELDS) expect(item, `${name}.${f}`).toHaveProperty(f);
      expect(item.actions.length, name).toBeGreaterThan(0);
      for (const a of item.actions) expect(["consent", "refuse", "edit", "dismiss"]).toContain(a.role);
    }
  });

  it("the raw act's summary is built from the tool and input, and outward decides the review step", () => {
    const push = buildRawAct("Bash", { command: "git push origin marvin/tab/x" });
    expect(push).toMatchObject({ toolName: "Bash", summary: "git push origin marvin/tab/x", outward: true, destructive: false });
    expect(push.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(buildRawAct("Edit", { file_path: ".env.local", old_string: "a", new_string: "b" })).toMatchObject({ summary: "Edit .env.local", paths: [".env.local"], outward: false });
    expect(buildRawAct("worktrees.drop", { slugs: ["tab-x"] })).toMatchObject({ destructive: true });
    const item = projectInboxItem(addInboxItem(P, drafts().confirm as InboxDraft), ctx(), listInbox(P));
    expect(item.actions.find((a) => a.role === "consent")).toMatchObject({ label: "Allow", requiresExpanded: true, recommended: true });
    expect(item.actions.find((a) => a.role === "refuse")?.label).toBe("Deny");
  });

  it("a finished tab's close item carries exactly one consent action", () => {
    const item = projectInboxItem(addInboxItem(P, drafts().close as InboxDraft), ctx(), listInbox(P));
    expect(item.actions.filter((a) => a.role === "consent")).toEqual([
      { id: "perform", label: "Close tab, keep branch", role: "consent", recommended: true, requiresExpanded: false },
    ]);
  });

  it("burstRank orders a tab's open items by age; tabless items rank on their own", () => {
    const a = addInboxItem(P, drafts().question as InboxDraft);
    const b = addInboxItem(P, drafts().confirm as InboxDraft);
    const all = listInbox(P);
    expect(projectInboxItem(a, ctx(), all).burstRank).toBe(0);
    expect(projectInboxItem(b, ctx(), all).burstRank).toBe(1);
  });
});

describe("Ground, full (§10.6)", () => {
  it("projects each kind with tree, label, resolved, excerpt and an openTarget the app can open", () => {
    mkdirSync(path.join(mainRoot, "docs", "decisions"), { recursive: true });
    writeFileSync(path.join(mainRoot, "docs", "decisions", "0107-one-worktree-per-tab.md"), "# ADR-0107 — One worktree per tab\n\nbody\n");
    writeFileSync(path.join(mainRoot, "notes.md"), "first\nthe cited line\nthird\n");
    const adr = projectGround({ kind: "adr", ref: "107", provenance: "strong" }, { ...ctx(), tab: null });
    for (const f of GROUND_FIELDS) expect(adr).toHaveProperty(f);
    expect(adr).toMatchObject({ kind: "adr", ref: "ADR-0107", tree: "main", resolved: true, provenance: "strong", label: "ADR-0107 — One worktree per tab" });
    expect(adr.openTarget?.path).toBe(path.join(mainRoot, "docs", "decisions", "0107-one-worktree-per-tab.md"));
    const file = projectGround({ kind: "file", ref: "main:notes.md:2", provenance: "strong" }, { ...ctx(), tab: null });
    expect(file).toMatchObject({ ref: "file:notes.md:2", excerpt: "the cited line", openTarget: { path: path.join(mainRoot, "notes.md"), line: 2 } });
    expect(projectGround({ kind: "plan", ref: "3", provenance: "weak" }, { ...ctx(), tab: "tab-1" })).toMatchObject({ kind: "plan-step", ref: "plan:[3]", tree: "tab-1", openTarget: null });
    expect(projectGround({ kind: "charter", ref: "Postgres, not SQLite", provenance: "strong" }, { ...ctx(), tab: null })).toMatchObject({ ref: "charter", excerpt: "Postgres, not SQLite" });
  });

  it("an unresolved ground projects weak and unresolved; a secret file is never excerpted or opened", () => {
    expect(projectGround({ kind: "adr", ref: "9999", provenance: "unresolved" }, { ...ctx(), tab: null })).toMatchObject({ provenance: "weak", resolved: false, openTarget: null });
    writeFileSync(path.join(mainRoot, ".env"), "API_KEY=sk-live-abc\n");
    const secret = projectGround({ kind: "file", ref: "main:.env:1", provenance: "strong" }, { ...ctx(), tab: null });
    expect(secret.excerpt).toBeNull();
    expect(secret.openTarget).toBeNull();
    // A link in the repository to a key outside it is the key, whatever the link is called.
    const outside = mkdtempSync(path.join(tmpdir(), "marvin-sup-m5i-home-"));
    writeFileSync(path.join(outside, "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n");
    symlinkSync(path.join(outside, "id_ed25519"), path.join(mainRoot, "notes-link.md"));
    const linked = projectGround({ kind: "file", ref: "main:notes-link.md:2", provenance: "strong" }, { ...ctx(), tab: null });
    expect(linked).toMatchObject({ excerpt: null, openTarget: null });
    rmSync(outside, { recursive: true, force: true });
  });
});

describe("the ledger's read shape (§10.5)", () => {
  it("projects every field, including a line written before milestone 3 (no reasonCode → code unspecified)", () => {
    appendLedgerEntry(P, { kind: "verb", verb: "answer", tab: "tab-1", wakeId: "w1", mode: "shadow", decision: "propose", reason: "grounded", argsDigest: "abcd", grounds: [] });
    appendLedgerEntry(P, { kind: "control", verb: "pause", tab: null, wakeId: null, mode: "shadow", reason: "user: pause" });
    appendLedgerEntry(P, { kind: "wake", verb: "start", tab: null, wakeId: "w2", mode: "shadow", reason: "1 item" });
    const page = projectLedger(P, readLedger(P), { limit: 50, groundCtx: ctx() });
    for (const e of page.entries) for (const f of LEDGER_VIEW_FIELDS) expect(e, f).toHaveProperty(f);
    expect(page.entries.map((e) => e.actor)).toEqual(["supervisor", "user", "runtime"]);
    expect(page.entries[0]).toMatchObject({ seq: 0, sessionId: "tab-1", argDigest: "abcd", reason: { code: "unspecified", text: "grounded" }, pairing: { agreement: "pending" } });
    expect(page).toMatchObject({ hasMore: false, nextBefore: null, todayCount: 3 });
  });

  it("pages backwards with before/limit, and filters by session and decision", () => {
    for (let i = 0; i < 5; i += 1) appendLedgerEntry(P, { kind: "verb", verb: "send", tab: i % 2 ? "tab-2" : "tab-1", wakeId: "w", decision: i === 4 ? "escalate" : "propose", reason: `r${i}` });
    const last2 = projectLedger(P, readLedger(P), { limit: 2, groundCtx: ctx() });
    expect(last2.entries.map((e) => e.seq)).toEqual([3, 4]);
    expect(last2).toMatchObject({ hasMore: true, nextBefore: 3 });
    expect(projectLedger(P, readLedger(P), { limit: 2, before: 3, groundCtx: ctx() }).entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(projectLedger(P, readLedger(P), { limit: 50, sessionId: "tab-2", groundCtx: ctx() }).entries.map((e) => e.seq)).toEqual([1, 3]);
    expect(projectLedger(P, readLedger(P), { limit: 50, decision: "escalate", groundCtx: ctx() }).entries.map((e) => e.seq)).toEqual([4]);
  });

  it("snapshots the tab's title at write time, so a closed tab keeps its name", () => {
    const posture = { model: "claude-sonnet-5-5", advisorModel: null, thinkingMode: "medium", permissionStrategy: "gated" as const, mode: "agent" as const, personality: "marvin" as const };
    upsertSessionMeta(P, "tab-1", { workDir: mainRoot, tree: { mode: "shared" }, posture }, { title: "Billing page" });
    appendLedgerEntry(P, { kind: "verb", verb: "send", tab: "tab-1", wakeId: "w", decision: "propose", reason: "r" });
    expect(readLedger(P)[0]?.tabTitle).toBe("Billing page");
    expect(projectLedger(P, readLedger(P), { limit: 5, groundCtx: ctx() }).entries[0]?.tabTitle).toBe("Billing page");
  });

  it("announces each appended line on the feed, without its reason or grounds", () => {
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => {
      if (e.event === "supervisor.ledger") seen.push(e);
    });
    try {
      appendLedgerEntry(P, { kind: "verb", verb: "send", tab: "tab-1", wakeId: "w", decision: "propose", reason: "secret-ish reason" });
      expect(seen[0]?.data).toMatchObject({ projectId: P, seq: 0, verb: "send", decision: "propose", sessionId: "tab-1" });
      expect(JSON.stringify(seen)).not.toContain("secret-ish");
    } finally {
      off();
    }
  });
});

describe("a posture-widen item's consent (milestone 6)", () => {
  it("performs the widening as the user, revisioned, from the next turn; the supervisor still cannot", async () => {
    const posture = { model: "claude-sonnet-5-5", personality: "ultron", permissionStrategy: "auto" as const, thinkingMode: "high", mode: "agent" as const };
    upsertSessionMeta(P, "tab-1", { workDir: mainRoot, tree: { mode: "shared" }, posture });
    const perform = defaultInboxPerform(P, mainRoot, null);
    const r = await perform.posture({ sessionId: "tab-1", patch: { permissionStrategy: "full" } });
    expect(r.ok).toBe(true);
    const meta = readSessionMeta(P, "tab-1");
    expect(meta?.posture.permissionStrategy).toBe("full");
    expect(meta?.postureSource).toBe("user");
    expect(meta?.postureRevision).toBe(1);
    const bySupervisor = applyPostureChange({ projectId: P, marvinSessionId: "tab-1", patch: { thinkingMode: "max" }, actor: "supervisor", lookup: () => null });
    expect(bySupervisor.ok).toBe(false);
  });
});
