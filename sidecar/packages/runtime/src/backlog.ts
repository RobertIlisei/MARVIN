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

import { buildAdrIndex, linkTrailerFor, stripLinkTrailer, type AdrIndex } from "./note-links";

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

/**
 * What KIND of work an item is — orthogonal to severity, which says how much
 * it matters (ADR-0064).
 *
 * Derived from a real 56-item backlog rather than picked off a shelf. Two of
 * these would be missing from a generic bug/improvement/chore taxonomy:
 *
 *  - `investigate` — the output is a DECISION, not a diff ("verify the EPPO
 *    codes", "recheck the TLS + LPIS vintage", "model the eco-scheme
 *    interaction"). ~1 in 5 items. Aging is normal for these, so the groomer
 *    must not nag about them the way it does about a stale bug.
 *  - `docs` — drift between what's written and what's true, which is neither a
 *    bug in the product nor an improvement to it.
 *
 * `unspecified` is the default and stays that way for every pre-existing item:
 * a guessed kind is worse than none, because filters then silently miss things.
 */
export const BACKLOG_KINDS = [
  "unspecified",
  "bug",
  "feature",
  "investigate",
  "test",
  "docs",
  "chore",
] as const;
export type BacklogKind = (typeof BACKLOG_KINDS)[number];

export interface BacklogItem {
  id: string; // slug
  title: string;
  body: string;
  status: BacklogStatus;
  severity: BacklogSeverity;
  /** What sort of work this is. See BACKLOG_KINDS. */
  kind: BacklogKind;
  /**
   * Waiting on something OUTSIDE the repo — a sign-off, a legal cutoff, a pilot
   * filing, an undecided policy.
   *
   * Deliberately NOT a kind and NOT a status value. It is orthogonal to both: a
   * blocked bug and a blocked feature are both blocked, and folding it into
   * `status` would make it mutually exclusive with `doing`. Before this, five
   * items nobody could act on sat as plain `open`, indistinguishable from work
   * that was ready — so "what can I pick up?" returned things it shouldn't.
   */
  blocked: boolean;
  /** What it's waiting on, in one line. Only meaningful when `blocked`. */
  blockedOn: string;
  /** Session that parked it (best-effort link back); empty for manual UI adds. */
  sessionId: string;
  created: string; // ISO
  updated: string; // ISO
}

export interface AddBacklogInput {
  title: string;
  body?: string;
  severity?: BacklogSeverity;
  kind?: BacklogKind;
  blocked?: boolean;
  blockedOn?: string;
  sessionId?: string;
  /**
   * ADR-0047 — auto-capture at discovery. `true` parks the item as
   * `provisional` (no user go-ahead needed; reviewed at the handoff). `false`
   * / omitted is a user-confirmed add (`open`), and CONFIRMS (promotes) an
   * existing provisional item to `open`.
   */
  provisional?: boolean;
  /**
   * Bypass the near-duplicate gate (ADR-0070). For the rare case where two
   * items really are distinct despite near-identical wording — the model must
   * say so deliberately rather than re-park by default.
   */
  force?: boolean;
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
      /** Set when the capture was refused as a restatement of this item. */
      duplicateOf?: string;
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
      duplicateOf?: string;
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

/**
 * Score at or above which a NEW capture is treated as a re-statement of an
 * existing live item and is refused rather than written (ADR-0070).
 *
 * Calibrated on two real duplicate pairs created within single sessions:
 *
 *   0.88  "ADR-0344: confirm generated_at-as-issued_date proxy for AVIZ_DOCUMENT"
 *       ~ "ADR-0344: confirm generated_at proxies issued_date for AVIZ_DOCUMENT"
 *   0.75  "Verify prod /opt/agricore/.env AGRICORE_POSTGRES_IMAGE and build-push"
 *       ~ "Verify prod .env AGRICORE_POSTGRES_IMAGE + whether build-push uses it"
 *
 * and against a genuinely distinct pair from the same session, which scores
 * **0.00**. 0.75 catches both duplicates with a wide margin above unrelated
 * work. Deliberately far above RELATED_MIN_SCORE (0.5), which stays advisory:
 * "possibly related" must keep meaning "look at this", not "blocked".
 */
export const NEAR_DUPLICATE_SCORE = 0.75;

/**
 * Minimum significant tokens on BOTH titles before the near-duplicate gate is
 * allowed to refuse a capture.
 *
 * Without this the score is computed from too little text to mean anything:
 * "Item one" vs "Item two" scores **1.00**, because the numerals are filtered
 * as insignificant and both titles collapse to the single token {item}. Any two
 * short titles sharing one word would be refused. Same reasoning as the Swift
 * side's `sameWorkPrefix` — a similarity signal needs enough input to be
 * evidence rather than coincidence. Below the floor the overlap is still
 * REPORTED (advisory), just never enforced.
 */
export const NEAR_DUPLICATE_MIN_TOKENS = 4;
/** Never surface more than this — a wall of maybes gets ignored wholesale. */
export const RELATED_MAX = 3;
/** A file in common is stronger evidence than a word in common, but not proof. */
const PATH_OVERLAP_BONUS = 0.4;

/**
 * Bonus when two titles name the same domain identifiers. Smaller than
 * `PATH_OVERLAP_BONUS` — a shared file path is a stronger signal than a shared
 * role name, because a path is where the work happens and a role is merely who
 * it concerns.
 *
 * Calibrated on the 2026-08-29 corpus: it lifts the one duplicate the gate
 * missed from 0.55 to 0.80 (over `NEAR_DUPLICATE_SCORE`), while the genuinely
 * distinct pairs from that same session sit at 0.09 and 0.15 and share at most
 * one identifier, so neither moves at all.
 */
const IDENTIFIER_OVERLAP_BONUS = 0.25;
const MIN_SHARED_IDENTIFIERS = 2;

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
 *
 * Tokenised from the FULL title, deliberately not via `slugify`. `slugify`
 * builds filenames and truncates at 60 chars, and reusing it here silently
 * scored only the first 60 characters of every title. Two real items from
 * 2026-08-29 —
 *
 *   "Audit SECURITY DEFINER functions in public now owned by BYPASSRLS
 *    agricore_migrate post-ADR-0363 transfer"
 *   "SECURITY DEFINER function ownership escalated agricore_app→agricore_migrate
 *    on V202608281000 routine transfer"
 *
 * — are the same finding, but every token that proves it (`agricore_migrate`,
 * `V202608281000`, `ADR-0363`, `transfer`) sits past character 60. The gate saw
 * 0.43 and parked a duplicate; on the full titles it sees 0.55.
 */
function significantTokens(title: string): Set<string> {
  const all = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const kept = all.filter((t) => !OVERLAP_STOPWORDS.has(t));
  // A title made entirely of stopwords ("fix the thing") would otherwise score
  // 0 against everything; fall back rather than go blind.
  return new Set((kept.length ? kept : all).map(stem));
}

/**
 * Domain identifiers in a title — the tokens that carry almost all the
 * discriminating signal in this corpus: SCREAMING acronyms (`BYPASSRLS`,
 * `RLS`, `DML`), migration/decision stamps (`V202608281000`, `ADR-0363`), and
 * snake_case names (`agricore_migrate`, `platform_audit`).
 *
 * Kept separate from `significantTokens` because containment treats every word
 * alike: two items can share "security", "definer" and "agricore_migrate" —
 * which between them name the exact object and role — and still lose to a pair
 * that happens to share four filler nouns.
 *
 * Case-sensitive by necessity, so this reads the ORIGINAL title, not a
 * lowercased one.
 */
function identifierTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(/\b[A-Z]{3,}\b/g)) out.add(m[0].toLowerCase());
  for (const m of title.matchAll(/\b[Vv]\d{6,}\b|\bADR-\d{3,}\b/g)) out.add(m[0].toLowerCase());
  for (const m of title.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) out.add(m[0]);
  return out;
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
  // Two or more shared identifiers, not one: `agricore_app` appears in a third
  // of this project's titles, so a single hit means "same codebase", not "same
  // work". Two means the pair names the same object AND the same actor.
  const sharedIdents = intersectionSize(
    identifierTokens(a.title),
    identifierTokens(b.title),
  );
  return Math.min(
    1,
    containment +
      (sharedPaths > 0 ? PATH_OVERLAP_BONUS : 0) +
      (sharedIdents >= MIN_SHARED_IDENTIFIERS ? IDENTIFIER_OVERLAP_BONUS : 0),
  );
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

/**
 * Blank any frontmatter value that is actually the NEXT field's line, swallowed
 * by the old `\s*` parser (2026-08-18).
 *
 * Safe by construction: the serializer writes every field on its own line, so a
 * swallowed line still exists in the file in its correct place — the bogus copy
 * is pure duplication and dropping it loses nothing. Verified on the real data:
 * every corrupted file held BOTH `blockedOn: sessionId: <uuid>` and a proper
 * `sessionId: <uuid>` line.
 */
export function repairSwallowedField(value: string): string {
  // Matched against the KNOWN field names only. A looser `^\w+:` test would
  // also blank a legitimate reason like "legal: DPA signature" — real
  // blockedOn values are prose and often contain a colon.
  return /^(?:id|title|status|severity|kind|blocked|blockedOn|sessionId|created|updated):\s/.test(
    value,
  )
    ? ""
    : value;
}

function parseField(content: string, field: string): string {
  // `[^\S\n]*` = horizontal whitespace ONLY. `\s*` also matches the NEWLINE,
  // so an EMPTY field swallowed the following line as its value — and the
  // serializer then wrote that back, corrupting the file permanently and
  // compounding on every subsequent save.
  //
  // Measured 2026-08-18 on a real project: 453 of 461 backlog files held
  // `blockedOn: sessionId: <uuid>`, some having swallowed two lines
  // (`blockedOn: sessionId: created: …`). The bug was latent here for as long as
  // this parser existed; ADR-0064's `blockedOn` — empty on ~98 % of items —
  // is what made every write hit it.
  return new RegExp(`^${field}:[^\\S\\n]*(.*)$`, "m").exec(content)?.[1]?.trim() ?? "";
}

function parseItem(slug: string, content: string): BacklogItem {
  const bodyStart = content.indexOf("\n---", 3);
  const afterFm = bodyStart >= 0 ? content.indexOf("\n", bodyStart + 1) : -1;
  // The link trailer is DERIVED (ADR-0065 addendum) — strip it so it never
  // counts toward the body cap, never shows in the detail view's body field,
  // and never round-trips into itself on the next write.
  const body = stripLinkTrailer(afterFm >= 0 ? content.slice(afterFm + 1).trim() : "").trim();
  const statusRaw = parseField(content, "status");
  const sevRaw = parseField(content, "severity");
  const kindRaw = parseField(content, "kind");
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
    // Absent in every file written before ADR-0064. Missing -> "unspecified"
    // rather than a guess: an invented kind would make filters silently wrong.
    kind: (BACKLOG_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as BacklogKind)
      : "unspecified",
    blocked: parseField(content, "blocked") === "true",
    // Self-heal files corrupted by the old parser (see repairSwallowedField).
    blockedOn: repairSwallowedField(parseField(content, "blockedOn")),
    sessionId: parseField(content, "sessionId"),
    created: parseField(content, "created"),
    updated: parseField(content, "updated"),
  };
}

/**
 * Write one item with its derived link trailer.
 *
 * Every write path goes through here so the trailer can never drift out of
 * sync with the body that produced it. `adrIndex` is passed in when a caller is
 * writing many items, so a relink pass scans the ADR directory once rather than
 * once per item.
 */
async function writeItem(
  workDir: string,
  item: BacklogItem,
  adrIndex?: AdrIndex,
): Promise<void> {
  const index = adrIndex ?? (await buildAdrIndex(workDir));
  const trailer = linkTrailerFor(`${item.title}\n${item.body}`, workDir, index);
  await writeFile(join(backlogDir(workDir), `${item.id}.md`), serialize(item, trailer), "utf-8");
}

/**
 * Regenerate every live item's link trailer. Used when turning a project into a
 * vault: existing notes predate the trailer, so without this the graph stays
 * two starbursts until each item happens to be touched again.
 */
export async function relinkBacklogNotes(workDir: string): Promise<number> {
  const items = await readAll(workDir);
  if (items.length === 0) return 0;
  const adrIndex = await buildAdrIndex(workDir);
  let n = 0;
  for (const item of items) {
    try {
      await writeItem(workDir, item, adrIndex);
      n += 1;
    } catch {
      /* skip unwritable */
    }
  }
  return n;
}

function serialize(item: BacklogItem, linkTrailer = ""): string {
  return (
    `---\n` +
    `id: ${item.id}\n` +
    `title: ${item.title.replace(/\n/g, " ").trim()}\n` +
    `status: ${item.status}\n` +
    `severity: ${item.severity}\n` +
    `kind: ${item.kind}\n` +
    `blocked: ${item.blocked ? "true" : "false"}\n` +
    `blockedOn: ${item.blockedOn.replace(/\n/g, " ").trim()}\n` +
    `sessionId: ${item.sessionId}\n` +
    `created: ${item.created}\n` +
    `updated: ${item.updated}\n` +
    `---\n\n${item.body || item.title}\n${linkTrailer}`
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
    // `[[backlog/<id>]]` rather than a bare path: Obsidian resolves it to the
    // note, which is what connects the index to its items in the graph view
    // (ADR-0065). Without links the vault is N disconnected dots. Reads the
    // same as the old text form everywhere else, including the context
    // injection that quotes this file.
    (i) => `- ${STATUS_MARK[i.status]} (${i.severity}) ${i.title} — [[backlog/${i.id}]]`,
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
    // An omitted kind KEEPS what's there rather than resetting to unspecified —
    // a re-add (or a provisional confirm) must not wipe a classification the
    // user made in the panel.
    kind: input.kind ?? existing?.kind ?? "unspecified",
    blocked: input.blocked ?? existing?.blocked ?? false,
    blockedOn: (input.blockedOn ?? existing?.blockedOn ?? "").trim().slice(0, 200),
    sessionId: input.sessionId ?? existing?.sessionId ?? "",
    created: existing?.created || now,
    updated: now,
  };
  // Near-duplicate check. Advisory at RELATED_MIN_SCORE — the item is written
  // and the overlap is surfaced for the user to judge.
  const related = relatedBacklogItems(item, all);

  // ADR-0070 — but a NEAR-IDENTICAL restatement is refused instead of written.
  // Measured: one session captured the same ADR-0344 question twice in two
  // wordings (0.88 similar), and another captured the same prod .env check
  // twice (0.75). Un-gated capture (ADR-0047) means the model re-parks a thing
  // it already parked minutes earlier, which is how a session ends 6-added /
  // 0-resolved.
  //
  // Non-destructive by construction: nothing is deleted or merged, the caller
  // is handed the EXISTING item, and `force` re-admits a genuinely distinct
  // item that happens to score high. Only applies when creating something new —
  // an update to an existing item (same title slug) is never blocked.
  if (!existing && !input.force) {
    const enoughSignal = (o: BacklogItem) =>
      significantTokens(item.title).size >= NEAR_DUPLICATE_MIN_TOKENS &&
      significantTokens(o.title).size >= NEAR_DUPLICATE_MIN_TOKENS;
    const dupe = all.find(
      (o) =>
        LIVE_STATUSES.has(o.status) &&
        enoughSignal(o) &&
        backlogSimilarity(item, o) >= NEAR_DUPLICATE_SCORE,
    );
    if (dupe) {
      return { ok: true, item: dupe, created: false, related, duplicateOf: dupe.id };
    }
  }

  try {
    await mkdir(dir, { recursive: true });
    await writeItem(workDir, item);
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
  fields: {
    severity?: BacklogSeverity;
    body?: string;
    kind?: BacklogKind;
    blocked?: boolean;
    blockedOn?: string;
  },
): Promise<ResolveResult> {
  const path = join(backlogDir(workDir), `${id}.md`);
  if (!existsSync(path)) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(path, "utf-8"));
  if (fields.severity !== undefined) item.severity = fields.severity;
  if (fields.body !== undefined) item.body = fields.body.trim().slice(0, MAX_BODY_CHARS);
  if (fields.kind !== undefined) item.kind = fields.kind;
  if (fields.blocked !== undefined) item.blocked = fields.blocked;
  if (fields.blockedOn !== undefined) item.blockedOn = fields.blockedOn.trim().slice(0, 200);
  // `updated` drives STALENESS, so only a change to the WORK counts as touching
  // it. Labelling an item is not engaging with it: a classification pass over a
  // whole backlog would otherwise reset every staleness clock at once and blind
  // the groomer for a month. Observed 2026-08-14 — classifying 58 items made
  // all 9 stale findings and every aging-bug vanish, which read like the new
  // exemptions working when it was really the timestamps being clobbered.
  const touchedWork = fields.body !== undefined || fields.severity !== undefined;
  if (touchedWork) item.updated = new Date().toISOString();
  try {
    await writeItem(workDir, item);
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
    await writeItem(workDir, item);
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to update backlog item: ${(err as Error).message}` };
  }
}
