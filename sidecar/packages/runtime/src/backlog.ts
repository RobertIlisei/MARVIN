/**
 * Project backlog store (ADR-0044) — a durable, per-project parking lot for
 * deferred-work items "noticed in flight, not in scope".
 *
 * Mirrors the durable-facts memory layer (`memory-mcp.ts`, ADR-0042): one item
 * → one small file under `<workDir>/.marvin/backlog/<slug>.md` + a one-line
 * index at `<workDir>/.marvin/backlog.md` (open + doing only). The deliberate
 * difference from memory is that this is a SHARED store: both the `marvin-backlog`
 * MCP tool (the model write path) AND the `/api/backlog` routes (the macOS UI)
 * read/write through here, so the file logic lives in one place.
 *
 * It is a PARKING LOT, not a Kanban board (Golden Rule 1): nothing here is
 * pulled by a subagent or executed autonomously. Bounded at the write boundary
 * (caps + content-class rejection in `classifyBacklogText`) — the ADR-0042
 * lesson that prose guidance alone let memory bloat to 419 KB.
 *
 * Scoped to the active project's workDir — never MARVIN's own repo.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INDEX_HEADER = "# Project Backlog";
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 2000;
/** Open+doing rail — a guard against a runaway queue, not a workload
 *  target. Raised 50 → 200 (2026-07-08): a real project hit 50 through
 *  ordinary capture-at-discovery use; the rail exists to stop a model
 *  auto-parking in a loop, not to force curation on the user. */
export const MAX_OPEN_ITEMS = 200;

// `provisional` (ADR-0047) is the pre-`open` stage: an item auto-captured the
// moment it was noticed in flight, awaiting the user's keep (→ open) / dismiss
// decision at the scope-met handoff. It persists + resurfaces like any item, so
// a discovery survives even if the turn never reaches a handoff.
export const BACKLOG_STATUSES = ["provisional", "open", "doing", "done", "dismissed"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];
export const BACKLOG_SEVERITIES = ["low", "med", "high"] as const;
export type BacklogSeverity = (typeof BACKLOG_SEVERITIES)[number];

export interface BacklogItem {
  id: string; // slug
  title: string;
  body: string;
  status: BacklogStatus;
  severity: BacklogSeverity;
  /** Session that parked it (best-effort link back); empty for manual UI adds. */
  sessionId: string;
  created: string; // ISO
  updated: string; // ISO
}

export interface AddBacklogInput {
  title: string;
  body?: string;
  severity?: BacklogSeverity;
  sessionId?: string;
  /**
   * ADR-0047 — auto-capture at discovery. `true` parks the item as
   * `provisional` (no user go-ahead needed; reviewed at the handoff). `false`
   * / omitted is a user-confirmed add (`open`), and CONFIRMS (promotes) an
   * existing provisional item to `open`.
   */
  provisional?: boolean;
}

export type AddBacklogResult =
  | {
      ok: true;
      item: BacklogItem;
      created: boolean;
      /**
       * Live items that look like the SAME work as the one just parked — the
       * near-duplicates exact-slug dedup can't see. Advisory only: the item is
       * always written, and nothing else is touched. See `relatedBacklogItems`.
       */
      related: BacklogItem[];
    }
  | { ok: false; error: string };

export type ResolveResult =
  | {
      ok: true;
      item: BacklogItem;
      /**
       * Populated by `resolveBacklogItem` only: live items that look connected
       * to what was just resolved, for the user to review at the handoff. Never
       * a licence to resolve them too.
       */
      related?: BacklogItem[];
    }
  | { ok: false; error: string };

/**
 * Content-class gate for the MODEL write path (the MCP tool). A backlog item is
 * an *actionable, scoped follow-up* — not a durable fact (→ `remember`), not
 * verification/commit status (→ git), not a decision (→ ADR). Pure + exported
 * so it's unit-testable at the boundary, like memory's BANNED_PATTERNS.
 */
const BANNED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bnot committed\b|\bnot pushed\b|\bcommitted\/pushed\b/i, why: "commit state lives in git, not a backlog" },
  { re: /\bvitest\b|\btsc clean\b|\beslint\b|\b\d+\/\d+ (tests|passing)\b|\ball tests pass\b/i, why: "test/verification status is ephemeral (→ git/CI)" },
  { re: /\bwe (chose|decided|will use)\b|\bdecision:\s|\bas-built\b/i, why: "a decision belongs in an ADR, not a backlog" },
];

export function classifyBacklogText(
  title: string,
  body: string,
): { ok: true } | { ok: false; why: string } {
  const haystack = `${title}\n${body}`;
  for (const { re, why } of BANNED_PATTERNS) {
    if (re.test(haystack)) return { ok: false, why };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Overlap detection — SURFACE ONLY, never mutate a sibling
// ---------------------------------------------------------------------------
//
// `addBacklogItem` dedups by exact slug, so "fix the outline crash" and "stop
// the file tree crashing" both park and neither ever notices the other. Un-gated
// capture at discovery (ADR-0047) makes that accumulate by construction — the
// open rail was raised 50 → 200 because a real project hit 50 through ordinary
// use.
//
// The fix is to DETECT and REPORT, never to reconcile. Auto-updating a sibling
// when its neighbour resolves would (a) mutate items that already passed the
// keep/dismiss gate, with no new consent point, (b) silently destroy captured
// work whenever the judgement is wrong — the exact evaporation this feature
// exists to prevent — and (c) turn the parking lot into a queue with its own
// state machine (Golden Rule 1). So these functions are pure and return
// candidates; the caller shows them to the USER, who decides.

/**
 * Score at or above which two items are worth showing side by side.
 *
 * Calibrated against `PATH_OVERLAP_BONUS` so that:
 *   - half the shorter title's meaningful words in common → related;
 *   - a shared file path PLUS any word in common → related;
 *   - a shared file path alone → NOT related (same file, different work).
 * Raise it if candidates read as noise; lower it if near-duplicates slip past.
 */
export const RELATED_MIN_SCORE = 0.5;
/** Never surface more than this — a wall of maybes gets ignored wholesale. */
export const RELATED_MAX = 3;
/** A file in common is stronger evidence than a word in common, but not proof. */
const PATH_OVERLAP_BONUS = 0.4;

/** Statuses that can still be acted on — a resolved item is not a duplicate. */
const LIVE_STATUSES: ReadonlySet<BacklogStatus> = new Set<BacklogStatus>([
  "provisional",
  "open",
  "doing",
]);

// Backlog titles are imperative and share a small verb/particle vocabulary
// ("fix the…", "add a…"). Those words carry no discriminating signal, so
// leaving them in would score every pair of items as half-alike.
const OVERLAP_STOPWORDS = new Set([
  "add", "and", "are", "back", "but", "can", "check", "drop", "fix", "for",
  "from", "get", "has", "have", "into", "its", "make", "move", "new", "not",
  "now", "off", "one", "only", "out", "over", "set", "should", "so", "some",
  "still", "stop", "that", "the", "then", "this", "update", "use", "using",
  "was", "when", "where", "which", "why", "with", "would",
]);

/** Crude singular fold so "crash"/"crashes" and "test"/"tests" agree. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

/**
 * Meaningful title words. Title only — pulling the body in would match any two
 * items that happen to share boilerplate prose.
 */
function significantTokens(title: string): Set<string> {
  const all = slugify(title).split("-").filter((t) => t.length >= 3);
  const kept = all.filter((t) => !OVERLAP_STOPWORDS.has(t));
  // A title made entirely of stopwords ("fix the thing") would otherwise score
  // 0 against everything; fall back rather than go blind.
  return new Set((kept.length ? kept : all).map(stem));
}

/**
 * File-ish tokens ("FileTreeView.swift", "src/backlog.ts:292"), reduced to a
 * bare lowercase basename so `src/backlog.ts` and `backlog.ts` agree.
 *
 * The extension must be alphabetic so version strings ("0.1.60") and prose
 * abbreviations ("e.g.") don't register as files.
 */
function filePaths(text: string): Set<string> {
  const out = new Set<string>();
  for (const ref of extractPathRefs(text)) {
    const base = ref.split("/").pop();
    if (base) out.add(base.toLowerCase());
  }
  return out;
}

/**
 * File-ish tokens as WRITTEN ("src/backlog.ts", "FileTreeView.swift:412"),
 * with any `:line` suffix stripped and the full path preserved.
 *
 * `filePaths` reduces these to basenames for similarity scoring, where
 * "same file mentioned twice" is the signal. The groomer needs the path as
 * written so it can ask whether that file still exists — a basename can't be
 * resolved against a workdir.
 *
 * The extension must be alphabetic so version strings ("0.1.60") and prose
 * abbreviations ("e.g.") don't register as files.
 */
export function extractPathRefs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9_/.-]{2,}\.[A-Za-z]{1,6}(?::\d+)?/g)) {
    out.push(m[0].replace(/:\d+$/, ""));
  }
  return out;
}

function intersectionSize<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const v of a) if (b.has(v)) n += 1;
  return n;
}

/**
 * How likely two backlog items are the same work — 0 (unrelated) to 1.
 *
 * Uses CONTAINMENT rather than Jaccard: backlog titles are short, and one is
 * often a more specific restatement of the other ("fix outline crash" vs "fix
 * the file-tree outline crash on refresh"). Jaccard penalises the longer title
 * for carrying extra words; containment asks the question we actually mean —
 * "is the smaller item subsumed by the bigger one?"
 *
 * Pure + exported so the calibration is unit-testable at the boundary, like
 * `classifyBacklogText`.
 */
export function backlogSimilarity(a: BacklogItem, b: BacklogItem): number {
  const ta = significantTokens(a.title);
  const tb = significantTokens(b.title);
  if (!ta.size || !tb.size) return 0;
  const containment = intersectionSize(ta, tb) / Math.min(ta.size, tb.size);
  const sharedPaths = intersectionSize(
    filePaths(`${a.title}\n${a.body}`),
    filePaths(`${b.title}\n${b.body}`),
  );
  return Math.min(1, containment + (sharedPaths > 0 ? PATH_OVERLAP_BONUS : 0));
}

/**
 * Live items that look like the same work as `target`, best match first.
 *
 * Returns candidates for a HUMAN to judge. Callers must not act on these:
 * nothing here is evidence enough to resolve, merge, or rewrite an item.
 */
export function relatedBacklogItems(
  target: BacklogItem,
  others: BacklogItem[],
  opts?: { minScore?: number; max?: number },
): BacklogItem[] {
  const minScore = opts?.minScore ?? RELATED_MIN_SCORE;
  const max = opts?.max ?? RELATED_MAX;
  return others
    .filter((o) => o.id !== target.id && LIVE_STATUSES.has(o.status))
    .map((item) => ({ item, score: backlogSimilarity(target, item) }))
    .filter((s) => s.score >= minScore)
    .sort((x, y) => y.score - x.score || x.item.id.localeCompare(y.item.id))
    .slice(0, max)
    .map((s) => s.item);
}

function slugify(title: string): string {
  const mapped = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = mapped.replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return trimmed || "item";
}

function backlogDir(workDir: string): string {
  return join(workDir, ".marvin", "backlog");
}
function indexFile(workDir: string): string {
  return join(workDir, ".marvin", "backlog.md");
}

function parseField(content: string, field: string): string {
  return new RegExp(`^${field}:\\s*(.*)$`, "m").exec(content)?.[1]?.trim() ?? "";
}

function parseItem(slug: string, content: string): BacklogItem {
  const bodyStart = content.indexOf("\n---", 3);
  const afterFm = bodyStart >= 0 ? content.indexOf("\n", bodyStart + 1) : -1;
  const body = afterFm >= 0 ? content.slice(afterFm + 1).trim() : "";
  const statusRaw = parseField(content, "status");
  const sevRaw = parseField(content, "severity");
  return {
    id: parseField(content, "id") || slug,
    title: parseField(content, "title") || slug,
    body,
    status: (BACKLOG_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as BacklogStatus)
      : "open",
    severity: (BACKLOG_SEVERITIES as readonly string[]).includes(sevRaw)
      ? (sevRaw as BacklogSeverity)
      : "med",
    sessionId: parseField(content, "sessionId"),
    created: parseField(content, "created"),
    updated: parseField(content, "updated"),
  };
}

function serialize(item: BacklogItem): string {
  return (
    `---\n` +
    `id: ${item.id}\n` +
    `title: ${item.title.replace(/\n/g, " ").trim()}\n` +
    `status: ${item.status}\n` +
    `severity: ${item.severity}\n` +
    `sessionId: ${item.sessionId}\n` +
    `created: ${item.created}\n` +
    `updated: ${item.updated}\n` +
    `---\n\n${item.body || item.title}\n`
  );
}

async function readAll(workDir: string): Promise<BacklogItem[]> {
  const dir = backlogDir(workDir);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const items: BacklogItem[] = [];
  for (const f of files.sort()) {
    try {
      const content = await readFile(join(dir, f), "utf-8");
      items.push(parseItem(f.replace(/\.md$/, ""), content));
    } catch {
      /* skip unreadable */
    }
  }
  return items;
}

const STATUS_MARK: Record<BacklogStatus, string> = {
  provisional: "[?]",
  open: "[ ]",
  doing: "[~]",
  done: "[x]",
  dismissed: "[-]",
};

/**
 * Rebuild `.marvin/backlog.md` from the item files. Lists only open + doing
 * (active work); done/dismissed drop from the index but keep their files as
 * history. Returns the active count.
 */
export async function rewriteBacklogIndex(workDir: string): Promise<number> {
  // Active rail = provisional + open + doing. Provisional items (ADR-0047) are
  // listed too so an auto-captured discovery resurfaces next session even if it
  // was never reviewed — losing it is the failure this exists to prevent.
  const active = (await readAll(workDir))
    .filter((i) => i.status === "provisional" || i.status === "open" || i.status === "doing")
    .sort((a, b) => {
      const order = { high: 0, med: 1, low: 2 } as const;
      return order[a.severity] - order[b.severity] || a.created.localeCompare(b.created);
    });
  const lines = active.map(
    (i) => `- ${STATUS_MARK[i.status]} (${i.severity}) ${i.title} — backlog/${i.id}.md`,
  );
  const body =
    `${INDEX_HEADER}\n\n` +
    `Parked follow-ups (open + in-progress; \`[?]\` = auto-captured, awaiting your ` +
    `keep/dismiss). One line per item; details in \`.marvin/backlog/<slug>.md\`. ` +
    `A PARKING LOT, not a queue agents pull from (ADR-0044) — resolve via the ` +
    `\`backlog_resolve\` tool or the backlog panel; done/dismissed items drop from ` +
    `this index (files kept).\n\n` +
    (lines.length ? lines.join("\n") : "_No open backlog items._") +
    "\n";
  await writeFile(indexFile(workDir), body, "utf-8");
  return active.length;
}

export async function listBacklog(
  workDir: string,
  opts?: { status?: BacklogStatus },
): Promise<BacklogItem[]> {
  const all = await readAll(workDir);
  return opts?.status ? all.filter((i) => i.status === opts.status) : all;
}

/**
 * Add (or re-open / update) a backlog item. Dedups by slug: re-adding the same
 * title updates fields in place rather than duplicating, and re-opens a
 * previously done/dismissed item. Applies length + open-count caps.
 */
export async function addBacklogItem(
  workDir: string,
  input: AddBacklogInput,
): Promise<AddBacklogResult> {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, error: "title is empty" };
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `title is ${title.length} chars (max ${MAX_TITLE_CHARS}) — keep it to one actionable line.` };
  }
  const body = (input.body ?? "").trim();
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, error: `body is ${body.length} chars (max ${MAX_BODY_CHARS}); a backlog item is a pointer, not a doc.` };
  }
  const severity: BacklogSeverity = input.severity ?? "med";
  const slug = slugify(title);
  const dir = backlogDir(workDir);
  const path = join(dir, `${slug}.md`);
  const now = new Date().toISOString();

  const existing = existsSync(path)
    ? parseItem(slug, await readFile(path, "utf-8"))
    : null;

  // Read once and reuse for both the open-count rail and overlap detection.
  const all = await readAll(workDir);

  // Open-count rail only applies to genuinely NEW open items. Provisional
  // auto-captures (ADR-0047) bypass it — silently blocking a discovery is the
  // exact loss this feature exists to prevent; the handoff review is the
  // bloat control, not a capture gate.
  if (!existing && !input.provisional) {
    const active = all.filter(
      (i) => i.status === "open" || i.status === "doing",
    ).length;
    if (active >= MAX_OPEN_ITEMS) {
      return { ok: false, error: `backlog already has ${active} open items (cap ${MAX_OPEN_ITEMS}); resolve some before adding more.` };
    }
  }

  // Status resolution (ADR-0047):
  //  - existing open/doing → keep (a provisional re-add never downgrades it);
  //  - existing provisional → confirm (provisional:false) promotes to open,
  //    else stays provisional;
  //  - new or re-opened-from-resolved → provisional if flagged, else open.
  let status: BacklogStatus;
  if (existing && (existing.status === "open" || existing.status === "doing")) {
    status = existing.status;
  } else if (existing && existing.status === "provisional") {
    status = input.provisional ? "provisional" : "open";
  } else {
    status = input.provisional ? "provisional" : "open";
  }

  const item: BacklogItem = {
    id: slug,
    title,
    body,
    status,
    severity,
    sessionId: input.sessionId ?? existing?.sessionId ?? "",
    created: existing?.created || now,
    updated: now,
  };
  // Near-duplicate check. Advisory ONLY — the item is written either way. An
  // overlap is a prompt for the user ("this looks like `outline-crash`, still
  // want both?"), never grounds to drop a capture on the model's judgement.
  const related = relatedBacklogItems(item, all);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, serialize(item), "utf-8");
    await rewriteBacklogIndex(workDir);
    return { ok: true, item, created: !existing, related };
  } catch (err) {
    return { ok: false, error: `failed to write backlog item: ${(err as Error).message}` };
  }
}

/**
 * Transition an item to a terminal status. Used by resolve + dismiss.
 *
 * Also reports the still-live items that look like the same work, so resolving
 * one of a pair of near-duplicates surfaces the other instead of leaving it to
 * rot. It does NOT touch them: whether the sibling is now obsolete is a
 * semantic judgement, and getting it wrong silently deletes captured work. The
 * caller shows the list; the user decides at the keep/dismiss handoff that
 * already exists (ADR-0044 addendum).
 */
export async function resolveBacklogItem(
  workDir: string,
  args: { id: string; resolution: "done" | "dismissed"; note?: string },
): Promise<ResolveResult> {
  const res = await setBacklogStatus(workDir, args.id, args.resolution, args.note);
  if (!res.ok) return res;
  return { ok: true, item: res.item, related: relatedBacklogItems(res.item, await readAll(workDir)) };
}

/** Id-keyed field edit — severity and/or body REPLACE (unlike the
 *  note-append in `setBacklogStatus`). Title is deliberately not
 *  editable: the slug/id/filename derive from it, so a rename is a
 *  new item, not an edit. Used by the UI's backlog detail view. */
export async function updateBacklogItem(
  workDir: string,
  id: string,
  fields: { severity?: BacklogSeverity; body?: string },
): Promise<ResolveResult> {
  const path = join(backlogDir(workDir), `${id}.md`);
  if (!existsSync(path)) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(path, "utf-8"));
  if (fields.severity !== undefined) item.severity = fields.severity;
  if (fields.body !== undefined) item.body = fields.body.trim().slice(0, MAX_BODY_CHARS);
  item.updated = new Date().toISOString();
  try {
    await writeFile(path, serialize(item), "utf-8");
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to update backlog item: ${(err as Error).message}` };
  }
}

/** Set any status (e.g. `doing` when promoted to a turn). Rewrites the index. */
export async function setBacklogStatus(
  workDir: string,
  id: string,
  status: BacklogStatus,
  note?: string,
): Promise<ResolveResult> {
  const path = join(backlogDir(workDir), `${id}.md`);
  if (!existsSync(path)) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(path, "utf-8"));
  item.status = status;
  item.updated = new Date().toISOString();
  if (note && note.trim()) {
    item.body = `${item.body}\n\n> ${status} — ${note.trim()}`.trim().slice(0, MAX_BODY_CHARS);
  }
  try {
    await writeFile(path, serialize(item), "utf-8");
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to update backlog item: ${(err as Error).message}` };
  }
}
