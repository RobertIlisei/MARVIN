/**
 * The escalation inbox (ADR-0127 §4–§5, plan milestone 5, design brief §10.2).
 *
 * Every act the supervisor may not perform — a §4 act, a weakly grounded one,
 * a guardrail pause, a tab it may only propose — becomes an item here. The
 * item shows the **raw act** (tool, full input, digest, a summary the server
 * builds from the tool and input, never from the supervisor's prose) with the
 * supervisor's recommendation beside it. The user's click on the raw act is
 * the consent (§5), performed with `actor: "user"`.
 *
 * - **Event-sourced, append-only.** Each change writes the whole item again as
 *   a new line in `<MARVIN_DATA_DIR>/supervisor/<projectId>/inbox.jsonl`; the
 *   newest line per id is the item. Same discipline as the ledger: `O_APPEND`,
 *   fsync, 0600, under the data dir — never the project's `.marvin/`, which a
 *   repository can write.
 * - **Actions come from the server.** Each item's `actions` are derived here
 *   from what the item is, with a `role` (`consent`, `refuse`, `edit`,
 *   `dismiss`), so the app invents no act verbs.
 * - **Items resolve on their own** when the confirm or question they are about
 *   is answered anywhere (`resolveInboxForConfirm`).
 * - **The feed** carries ids and states only (`supervisor.inbox`); the item is
 *   token-gated behind `GET /api/supervisor/inbox`.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";

import type { PosturePatch } from "./posture";
import type { SessionPosture } from "./session-meta";
import { shellWriteTargets, withoutGitGlobalOptions } from "./supervisor-acts";
import { digestArgs, ensureSupervisorDir, type LedgerGround, supervisorDir } from "./supervisor-ledger";
import { type Ground, type GroundViewContext, projectGround } from "./supervisor-view";
import { announceProjectEvent } from "./turn-registry";

export const INBOX_KINDS = ["question", "confirm", "integration", "containment", "discard", "boundary-path", "posture-widen", "scope", "new-tab", "guardrail"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
export type InboxState = "open" | "resolved" | "dismissed" | "superseded";
export type InboxResolvedBy = "user" | "tab" | "expired";

export type EscalationCode =
  | "human-only"
  | "ungrounded"
  | "weak-grounds-only"
  | "unresolvable-citation"
  | "heuristic"
  | "delegation-observe"
  | "nudge-cap"
  | "budget"
  | "breaker"
  | "refusals"
  | "repeated-failures"
  /** ADR-0128 §6 — the user wrote to the supervisor during the wake; its acts wait for the user. */
  | "message-hold";

export interface RawAct {
  toolName: string;
  input: Record<string, unknown>;
  digest: string;
  summary: string;
  /** Leaves the machine or spends money (push, a request, CI): the card asks for "Review act…" first. */
  outward: boolean;
  destructive: boolean;
  paths?: string[];
}

export interface MergePreview {
  kind: "merge-tree";
  verdict: "clean" | "behind" | "conflict" | "unknown";
  behind?: number;
  added: number;
  removed: number;
  conflictFiles: string[];
}

export interface NewTabProposal {
  firstMessage: string;
  tree: { baseRef: string | null; baseSha: string | null; mode: "worktree" };
  posture: { model: string; modelLabel: string; effort: string; strategy: string; mode: string };
  /** Posture dimensions wider than the requesting tab's — the card marks each. */
  wider: string[];
  /** The brief also names `approved-proposal`; nothing writes it — approving a suggestion is the user's message (plan, milestone 5). */
  requestedBy: { kind: "user-message"; ref: string; at: string };
}

/** What consent replays. Server-side only: never built from the supervisor's description of the act. */
export type InboxAct =
  | { type: "answer"; turnId: string; toolUseId: string; answers: Record<string, string | string[]>; other: Record<string, string> }
  | { type: "confirm"; turnId: string; toolUseId: string }
  | { type: "posture"; sessionId: string; patch: PosturePatch }
  | { type: "send"; sessionId: string; text: string; kind: "nudge" | "instruction"; grounds: LedgerGround[] }
  | { type: "cancel"; sessionId: string }
  | { type: "worktrees"; op: "merge" | "merge-all" | "prepare-mr" | "drop"; slugs: string[]; push?: boolean; openMergeRequest?: boolean }
  | { type: "close"; sessionId: string; worktree: "keep" | "merge" | "discard" }
  | { type: "new-tab"; requestId: string; title?: string; posture: SessionPosture; grounds: LedgerGround[] }
  | { type: "guardrail"; pause: string };

export interface InboxDraft {
  id?: string;
  sessionId: string | null;
  kind: InboxKind;
  escalatedBecause: { code: EscalationCode; label: string; rule?: string };
  heuristic?: { matched: string } | null;
  rawAct?: RawAct | null;
  preview?: MergePreview | null;
  question?: { questions: unknown[] } | null;
  linkedConfirm?: { sessionId: string; turnId: string; toolUseId: string; raisingRule: string | null } | null;
  recommendation?: { actionId: string; answer?: Record<string, string | string[]>; text: string } | null;
  grounds?: LedgerGround[];
  newTab?: NewTabProposal | null;
  postureChange?: { from: Record<string, unknown>; to: Record<string, unknown>; widenedDimensions: string[] } | null;
  guardrail?: { kind: string; detail: string; verb?: "raise-cap" | "resume" | "open-tab" } | null;
  modeAtCreation: "shadow" | "autonomous";
  wakeId?: string | null;
  /** The ledger line that escalated it. */
  ledgerId?: string | null;
  tabTitle?: string | null;
  act?: InboxAct | null;
  /** One item per key, across every state: a dismissed item is not raised again for the same cause. */
  dedupeKey?: string;
}

export interface InboxRecord extends Required<Omit<InboxDraft, "id" | "dedupeKey">> {
  id: string;
  revision: number;
  createdAt: string;
  state: InboxState;
  resolvedBy: InboxResolvedBy | null;
  resolvedAt: string | null;
  dedupeKey: string | null;
}

/** Every field the brief's §10.2 names; a route test reads each one from an item of each kind. */
export const INBOX_ITEM_FIELDS = [
  "id",
  "revision",
  "createdAt",
  "wakeId",
  "sessionId",
  "kind",
  "escalatedBecause",
  "heuristic",
  "rawAct",
  "preview",
  "question",
  "linkedConfirm",
  "recommendation",
  "grounds",
  "actions",
  "newTab",
  "postureChange",
  "guardrail",
  "modeAtCreation",
  "state",
  "resolvedBy",
  "resolvedAt",
  "burstRank",
] as const;

export const MAX_RECOMMENDATION_CHARS = 500;

// ── The raw act (server-built) ──────────────────────────────────────────────

const OUTWARD_SHELL = [/\bgit\s+push\b/, /\b(gh\s+pr|glab\s+mr)\s+(create|merge)\b/, /\b(gh|glab)\s+(workflow|ci|pipeline|run)\b/];
const firstLine = (s: string, n = 160) => {
  const l = s.split("\n")[0] ?? "";
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Deterministic from the tool and its input — the line the user consents to, never the supervisor's prose. */
export function buildRawAct(toolName: string, input: Record<string, unknown>): RawAct {
  const digest = digestArgs({ toolName, input });
  const make = (summary: string, outward = false, destructive = false, paths?: string[]): RawAct => ({
    toolName,
    input,
    digest,
    summary,
    outward,
    destructive,
    ...(paths && paths.length ? { paths } : {}),
  });
  const slugs = strArr(input.slugs);
  switch (toolName) {
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command.trim() : "";
      const plain = withoutGitGlobalOptions(cmd);
      return make(firstLine(cmd), OUTWARD_SHELL.some((re) => re.test(plain)), false, shellWriteTargets(plain));
    }
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const p = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
      return make(`${toolName} ${p}`, false, false, p ? [p] : []);
    }
    case "worktrees.merge":
      return make(`Merge ${slugs.join(", ")} into the current branch, locally`);
    case "worktrees.merge-all":
      return make("Merge every finished branch into the current branch, locally");
    case "worktrees.prepare-mr": {
      const push = input.push === true;
      const mr = input.openMergeRequest === true;
      return make(`Squash ${slugs.length} branch${slugs.length === 1 ? "" : "es"} into one merge-request branch${push ? ", push it" : ""}${mr ? ", open a merge request" : ""}`, push || mr);
    }
    case "worktrees.drop":
      return make(`Drop worktree ${slugs.join(", ")} and its branch, with its commits and changes`, false, true);
    case "close_session": {
      const how = input.worktree === "merge" ? "merge its branch into the current branch" : input.worktree === "discard" ? "discard its worktree and branch" : "keep its branch";
      return make(`Close tab ${String(input.marvinSessionId ?? "")} and ${how}`, false, input.worktree === "discard");
    }
    case "set_posture": {
      const p = (input.posture ?? {}) as Record<string, unknown>;
      return make(`Set ${Object.entries(p).map(([k, v]) => `${k} ${String(v)}`).join(", ") || "no change"} on tab ${String(input.marvinSessionId ?? "")}`);
    }
    case "send":
      return make(`Send to tab ${String(input.marvinSessionId ?? "")}: ${firstLine(String(input.message ?? ""), 120)}`);
    case "cancel":
      return make(`Stop the running turn in tab ${String(input.marvinSessionId ?? "")}`);
    case "new_session":
      return make("Open a new tab in a fresh worktree");
    default:
      return make(toolName.startsWith("mcp__") ? `${toolName} (a server MARVIN did not register)` : toolName);
  }
}

// ── The store ───────────────────────────────────────────────────────────────

export function inboxPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "inbox.jsonl");
}

const cache = new Map<string, { size: number; mtimeMs: number; items: Map<string, InboxRecord> }>();

function load(projectId: string): Map<string, InboxRecord> {
  const p = inboxPath(projectId);
  if (!existsSync(p)) return new Map();
  const st = statSync(p);
  const hit = cache.get(p);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.items;
  const items = new Map<string, InboxRecord>();
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = (JSON.parse(line) as { item?: InboxRecord }).item;
      if (rec?.id) items.set(rec.id, rec);
    } catch {
      /* a torn final line */
    }
  }
  cache.set(p, { size: st.size, mtimeMs: st.mtimeMs, items });
  return items;
}

function write(projectId: string, rec: InboxRecord, change: "added" | "updated" | "resolved"): InboxRecord {
  ensureSupervisorDir(projectId);
  const p = inboxPath(projectId);
  const prevSize = existsSync(p) ? statSync(p).size : 0;
  const fd = openSync(p, "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), item: rec })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Our own write extends a fresh cache in place; a stale one is re-read on the next load.
  const hit = cache.get(p);
  if (hit && hit.size === prevSize) {
    const st = statSync(p);
    hit.items.set(rec.id, rec);
    hit.size = st.size;
    hit.mtimeMs = st.mtimeMs;
  }
  try {
    announceProjectEvent({
      event: "supervisor.inbox",
      data: { projectId, change, id: rec.id, revision: rec.revision, sessionId: rec.sessionId, kind: rec.kind, state: rec.state, resolvedBy: rec.resolvedBy },
    });
  } catch {
    /* the item stands; only the notification is lost */
  }
  return rec;
}

export function getInboxItem(projectId: string, id: string): InboxRecord | null {
  return load(projectId).get(id) ?? null;
}

/** Items, oldest first. */
export function listInbox(projectId: string, opts: { state?: InboxState; sessionId?: string } = {}): InboxRecord[] {
  return [...load(projectId).values()]
    .filter((i) => (opts.state === undefined || i.state === opts.state) && (opts.sessionId === undefined || i.sessionId === opts.sessionId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/** Add an item, or return the existing one with the same `dedupeKey` (in any state). */
export function addInboxItem(projectId: string, draft: InboxDraft): InboxRecord {
  if (draft.dedupeKey) {
    const same = [...load(projectId).values()].find((i) => i.dedupeKey === draft.dedupeKey);
    if (same) return same;
  }
  const rec: InboxRecord = {
    id: draft.id ?? randomUUID(),
    revision: 1,
    createdAt: new Date().toISOString(),
    sessionId: draft.sessionId,
    kind: draft.kind,
    escalatedBecause: draft.escalatedBecause,
    heuristic: draft.heuristic ?? null,
    rawAct: draft.rawAct ?? null,
    preview: draft.preview ?? null,
    question: draft.question ?? null,
    linkedConfirm: draft.linkedConfirm ?? null,
    recommendation: draft.recommendation ? { ...draft.recommendation, text: draft.recommendation.text.slice(0, MAX_RECOMMENDATION_CHARS) } : null,
    grounds: draft.grounds ?? [],
    newTab: draft.newTab ?? null,
    postureChange: draft.postureChange ?? null,
    guardrail: draft.guardrail ?? null,
    modeAtCreation: draft.modeAtCreation,
    wakeId: draft.wakeId ?? null,
    ledgerId: draft.ledgerId ?? null,
    tabTitle: draft.tabTitle ?? null,
    act: draft.act ?? null,
    dedupeKey: draft.dedupeKey ?? null,
    state: "open",
    resolvedBy: null,
    resolvedAt: null,
  };
  return write(projectId, rec, "added");
}

/** Change an open item's details (a preview arriving, an edit). Null when it is gone or settled. */
export function updateInboxItem(projectId: string, id: string, patch: Partial<Pick<InboxRecord, "preview" | "recommendation" | "newTab">>): InboxRecord | null {
  const cur = getInboxItem(projectId, id);
  if (!cur || cur.state !== "open") return null;
  return write(projectId, { ...cur, ...patch, revision: cur.revision + 1 }, "updated");
}

/** Settle an open item. Null when it was already settled — settling is once. */
export function settleInboxItem(projectId: string, id: string, how: { state: Exclude<InboxState, "open">; resolvedBy: InboxResolvedBy }): InboxRecord | null {
  const cur = getInboxItem(projectId, id);
  if (!cur || cur.state !== "open") return null;
  return write(projectId, { ...cur, state: how.state, resolvedBy: how.resolvedBy, resolvedAt: new Date().toISOString(), revision: cur.revision + 1 }, "resolved");
}

/**
 * ids being performed by an inbox consent right now. Their confirm resolves
 * inside the perform, and the item is the user's to settle, not the tab's.
 */
const inFlight = new Set<string>();
export function isInboxInFlight(id: string): boolean {
  return inFlight.has(id);
}
export function markInboxInFlight(id: string, on: boolean): void {
  if (on) inFlight.add(id);
  else inFlight.delete(id);
}

/**
 * The confirm or question an item is about was answered somewhere else — in
 * the tab, through the API — or ended unanswered. Answered: resolved by the
 * tab. Unanswered (a timeout, the turn unwinding): superseded, expired.
 */
export function resolveInboxForConfirm(projectId: string, d: { toolUseId: string; answeredBy?: "user" | "supervisor" | undefined }): number {
  let n = 0;
  for (const i of listInbox(projectId, { state: "open" })) {
    if (i.linkedConfirm?.toolUseId !== d.toolUseId || inFlight.has(i.id)) continue;
    const out = d.answeredBy ? settleInboxItem(projectId, i.id, { state: "resolved", resolvedBy: "tab" }) : settleInboxItem(projectId, i.id, { state: "superseded", resolvedBy: "expired" });
    if (out) n += 1;
  }
  return n;
}

/** Supersede every open item the predicate picks (a scope reopened, a guardrail lifted). */
export function supersedeInbox(projectId: string, pick: (i: InboxRecord) => boolean, resolvedBy: InboxResolvedBy = "expired"): number {
  let n = 0;
  for (const i of listInbox(projectId, { state: "open" })) {
    if (!inFlight.has(i.id) && pick(i) && settleInboxItem(projectId, i.id, { state: "superseded", resolvedBy })) n += 1;
  }
  return n;
}

export function openEscalationCounts(projectId: string): { total: number; byTab: Map<string, number> } {
  const byTab = new Map<string, number>();
  const open = listInbox(projectId, { state: "open" });
  for (const i of open) if (i.sessionId) byTab.set(i.sessionId, (byTab.get(i.sessionId) ?? 0) + 1);
  return { total: open.length, byTab };
}

// ── The item as the brief reads it ──────────────────────────────────────────

export interface InboxAction {
  id: string;
  label: string;
  role: "consent" | "refuse" | "edit" | "dismiss";
  recommended: boolean;
  requiresExpanded: boolean;
}

const DISMISS: InboxAction = { id: "dismiss", label: "Dismiss", role: "dismiss", recommended: false, requiresExpanded: false };

const PERFORM_LABEL: Record<string, string> = {
  "worktrees:merge": "Merge",
  "worktrees:merge-all": "Merge all",
  "worktrees:prepare-mr": "Prepare MR",
  "worktrees:drop": "Drop worktree",
  "close:keep": "Close tab, keep branch",
  "close:merge": "Close tab, merge branch",
  "close:discard": "Close tab, discard work",
  posture: "Apply posture",
  send: "Send to the tab",
  cancel: "Stop the turn",
};

/** The chips an item offers, in order. Labels come from here so the app invents no act verbs. */
export function actionsFor(i: InboxRecord): InboxAction[] {
  const act = i.act;
  const outward = i.rawAct?.outward === true;
  const rec = i.recommendation?.actionId;
  if (!act) return [DISMISS];
  switch (act.type) {
    case "answer":
      return [
        ...(i.recommendation?.answer ? [{ id: "answer", label: "Answer as recommended", role: "consent" as const, recommended: true, requiresExpanded: false }] : []),
        { id: "answer-edit", label: "Answer…", role: "edit", recommended: false, requiresExpanded: false },
        DISMISS,
      ];
    case "confirm":
      return [
        { id: "allow", label: "Allow", role: "consent", recommended: rec === "allow", requiresExpanded: outward },
        { id: "deny", label: "Deny", role: "refuse", recommended: rec === "deny", requiresExpanded: false },
        DISMISS,
      ];
    case "new-tab":
      return [
        { id: "open", label: "Open tab", role: "consent", recommended: true, requiresExpanded: false },
        { id: "edit", label: "Edit…", role: "edit", recommended: false, requiresExpanded: false },
        DISMISS,
      ];
    case "guardrail":
      return i.guardrail?.verb === "raise-cap"
        ? [
            { id: "raise-cap", label: "Raise cap…", role: "edit", recommended: true, requiresExpanded: false },
            { id: "resume", label: "Resume", role: "consent", recommended: false, requiresExpanded: false },
            DISMISS,
          ]
        : [{ id: "resume", label: "Resume", role: "consent", recommended: true, requiresExpanded: false }, DISMISS];
    default: {
      const key = act.type === "worktrees" ? `worktrees:${act.op}` : act.type === "close" ? `close:${act.worktree}` : act.type;
      return [{ id: "perform", label: PERFORM_LABEL[key] ?? "Perform", role: "consent", recommended: true, requiresExpanded: outward || i.rawAct?.destructive === true }, DISMISS];
    }
  }
}

export interface InboxItemView {
  id: string;
  revision: number;
  createdAt: string;
  wakeId: string | null;
  sessionId: string | null;
  tabTitle: string | null;
  kind: InboxKind;
  escalatedBecause: InboxRecord["escalatedBecause"];
  heuristic: { matched: string } | null;
  rawAct: RawAct | null;
  preview: MergePreview | null;
  question: { questions: unknown[] } | null;
  linkedConfirm: InboxRecord["linkedConfirm"];
  recommendation: InboxRecord["recommendation"];
  grounds: Ground[];
  actions: InboxAction[];
  newTab: NewTabProposal | null;
  postureChange: InboxRecord["postureChange"];
  guardrail: InboxRecord["guardrail"];
  modeAtCreation: "shadow" | "autonomous";
  state: InboxState;
  resolvedBy: InboxResolvedBy | null;
  resolvedAt: string | null;
  burstRank: number;
  ledgerId: string | null;
}

/** The brief's item. `all` is the project's items, for `burstRank` (age order among the tab's open items). */
export function projectInboxItem(i: InboxRecord, ctx: GroundViewContext, all: readonly InboxRecord[]): InboxItemView {
  const peers = all.filter((x) => x.state === "open" && x.sessionId === i.sessionId);
  const rank = peers.findIndex((x) => x.id === i.id);
  return {
    id: i.id,
    revision: i.revision,
    createdAt: i.createdAt,
    wakeId: i.wakeId,
    sessionId: i.sessionId,
    tabTitle: i.tabTitle,
    kind: i.kind,
    escalatedBecause: i.escalatedBecause,
    heuristic: i.heuristic,
    rawAct: i.rawAct,
    preview: i.preview,
    question: i.question,
    linkedConfirm: i.linkedConfirm,
    recommendation: i.recommendation,
    grounds: i.grounds.map((g) => projectGround(g, { ...ctx, tab: i.sessionId })),
    actions: i.state === "open" ? actionsFor(i) : [],
    newTab: i.newTab,
    postureChange: i.postureChange,
    guardrail: i.guardrail,
    modeAtCreation: i.modeAtCreation,
    state: i.state,
    resolvedBy: i.resolvedBy,
    resolvedAt: i.resolvedAt,
    burstRank: rank === -1 ? 0 : rank,
    ledgerId: i.ledgerId,
  };
}
