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
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { noteBacklogWrite } from "./backlog-live";
import { type AdrIndex, buildAdrIndex, linkTrailerFor, stripLinkTrailer } from "./note-links";

export const INDEX_HEADER = "# Project Backlog";
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 2000;
/** Dated notes (`> ` lines) have their own budget, separate from the
 *  description's. 2026-09-29: counting notes against the description cap left
 *  three long-running stage items at 2000 chars unable to take any progress
 *  note — the one thing a long-running item accumulates. */
export const MAX_NOTES_CHARS = 4000;

/** Why a body can't be stored, or null. Description = every line that isn't a
 *  `> ` note; notes = the `> ` lines. Each has its own cap; both refuse, never
 *  truncate. */
export function bodyLimitError(body: string, id?: string): string | null {
  const lines = body.split("\n");
  const notes = lines.filter((l) => l.startsWith(">")).join("\n");
  const description = lines.filter((l) => !l.startsWith(">")).join("\n").trim();
  if (description.length > MAX_BODY_CHARS) {
    return `the description is ${description.length} chars (max ${MAX_BODY_CHARS}); a backlog item is a pointer, not a doc — condense it and retry. Nothing was written.`;
  }
  if (notes.length > MAX_NOTES_CHARS) {
    // Refuse with advice, never silently and never by raising the cap
    // (ADR-0044 addendum, 2026-11-27): an item that has outgrown its notes is
    // two pieces of work, and the second one is a new item that points back.
    return (
      `the notes are ${notes.length} chars (max ${MAX_NOTES_CHARS}); this item cannot take more. ` +
      `File the new point as its own item with backlog_add and \`relatesTo: "${id ?? "<this item's slug>"}"\`, ` +
      `or condense the older notes with backlog_update (move history to the item's source doc). Nothing was written.`
    );
  }
  return null;
}
/** Open+doing rail — a guard against a runaway queue, not a workload
 *  target. Raised 50 → 200 (2026-07-08): a real project hit 50 through
 *  ordinary capture-at-discovery use; the rail exists to stop a model
 *  auto-parking in a loop, not to force curation on the user.
 *  Raised 200 → 500 (2026-11-18): the same project sat at 200 with every item
 *  groomed twice in two days, and three grooming sessions had to write 88 real
 *  follow-ups as notes on other items because `backlog_add` refused them. */
export const MAX_OPEN_ITEMS = 500;

// `provisional` (ADR-0047) is the pre-`open` stage: an item auto-captured the
// moment it was noticed in flight, awaiting the user's keep (→ open) / dismiss
// decision at the scope-met handoff. It persists + resurfaces like any item, so
// a discovery survives even if the turn never reaches a handoff.
export const BACKLOG_STATUSES = ["provisional", "open", "doing", "done", "dismissed"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

/**
 * Priority — how much an item matters. One field, three values (ADR-0044
 * addendum, 2026-11-27). It was `severity: low|med|high` and had drifted into
 * `medium`, `hi` and others as tabs and people wrote it by hand; the write path
 * now accepts exactly these three and every reader folds the old spellings.
 */
export const BACKLOG_PRIORITIES = ["low", "medium", "high"] as const;
export type BacklogPriority = (typeof BACKLOG_PRIORITIES)[number];

const PRIORITY_SYNONYMS: Record<string, BacklogPriority> = {
  low: "low", lo: "low", minor: "low", trivial: "low",
  medium: "medium", med: "medium", mid: "medium", normal: "medium", moderate: "medium",
  high: "high", hi: "high", major: "high", urgent: "high", critical: "high",
};

/** READ side: any spelling a file or an older client ever used → one of the three. An unknown value is `medium`, never a refusal. */
export function normalizePriority(raw: string | undefined | null): BacklogPriority {
  return PRIORITY_SYNONYMS[(raw ?? "").trim().toLowerCase()] ?? "medium";
}

/** Like `normalizePriority`, but null for a value that is not a priority spelling at all (the wire route, which still accepts the old `med`). */
export function lenientPriority(raw: string | undefined | null): BacklogPriority | null {
  return PRIORITY_SYNONYMS[(raw ?? "").trim().toLowerCase()] ?? null;
}

/** WRITE side (tools): exactly `low | medium | high`, with a message that says so. */
export function parsePriority(raw: unknown): { ok: true; value: BacklogPriority } | { ok: false; error: string } {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if ((BACKLOG_PRIORITIES as readonly string[]).includes(v)) return { ok: true, value: v as BacklogPriority };
  const hint = lenientPriority(typeof raw === "string" ? raw : "");
  return {
    ok: false,
    error: `priority ${JSON.stringify(raw)} is not valid — use exactly one of ${BACKLOG_PRIORITIES.join(", ")}${hint ? ` (did you mean "${hint}"?)` : ""}. Nothing was written.`,
  };
}

/** The old three-letter spelling the macOS pane still reads (`severity: "med"`). Emitted on the wire and mirrored in the file; dropped when the pane reads `priority`. */
export function legacySeverity(p: BacklogPriority): "low" | "med" | "high" {
  return p === "medium" ? "med" : p;
}

/** Coarse nature of an item; orthogonal to `kind` (ADR-0064), which stays. */
export const BACKLOG_TYPES = ["bug", "debt", "idea", "chore"] as const;
export type BacklogType = (typeof BACKLOG_TYPES)[number];

const MAX_RELEASE_CHARS = 40;
const MAX_ORIGIN_CHARS = 80;
const MAX_WAITS_ON_CHARS = 200;

/** Single-line optional text field with a cap; refuses, never truncates. */
function lineField(name: string, raw: string | undefined, max: number): { ok: true; value: string } | { ok: false; error: string } {
  const v = (raw ?? "").replace(/\s+/g, " ").trim();
  if (v.length > max) return { ok: false, error: `${name} is ${v.length} chars (max ${max}); keep it to one short line. Nothing was written.` };
  return { ok: true, value: v };
}

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
  /** low | medium | high. Was `severity` (low|med|high) before 2026-11-27. */
  priority: BacklogPriority;
  /** What sort of work this is. See BACKLOG_KINDS. */
  kind: BacklogKind;
  /** bug | debt | idea | chore, or empty. The coarse split the research report asks for. */
  type: BacklogType | "";
  /** Free text: the release it was found in or is aimed at ("v3.2"). */
  release: string;
  /** Where it came from: a session id or a review name. */
  origin: string;
  /** What it waits on: owner, authority, reviewer, another slug, or a line. */
  waitsOn: string;
  /** Slug of the item this one continues (a new item filed because the old one's notes were full). */
  relatesTo: string;
  /** "derived" when the item was closed by a `Backlog:` trailer on a commit (git-derived, not a person's decision). */
  resolvedBy: "" | "derived";
  /** For a derived resolution: the commit sha that proves it. */
  evidence: string;
  /** When a resolved item was last reopened (ISO). A fix commit older than this does not close it again. */
  reopenedAt: string;
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
  /** ADR-0113 — who is working it while `status === "doing"`. Empty otherwise. */
  claimedBy: string;
  /** The holder's branch (a worktree tab), for the human-facing "tab: …". */
  claimedBranch: string;
  claimedAt: string;
  created: string; // ISO
  updated: string; // ISO
}

/** ADR-0113 — the holder of a `doing` item, as listings and refusals name it. */
export interface BacklogClaim {
  sessionId: string;
  branch?: string | undefined;
}

/** "tab: fix-the-thing" or "session 8cb24ed6" — whichever the claim recorded. */
export function describeClaim(item: Pick<BacklogItem, "claimedBy" | "claimedBranch">): string | null {
  if (!item.claimedBy) return null;
  if (item.claimedBranch) {
    const short = item.claimedBranch.startsWith("marvin/tab/") ? item.claimedBranch.slice("marvin/tab/".length) : item.claimedBranch;
    return `tab: ${short}`;
  }
  return `session ${item.claimedBy.slice(0, 8)}`;
}

export interface AddBacklogInput {
  title: string;
  body?: string;
  priority?: BacklogPriority;
  kind?: BacklogKind;
  type?: BacklogType;
  release?: string;
  origin?: string;
  waitsOn?: string;
  /** Slug of an existing item (open or archived) this one follows up. */
  relatesTo?: string;
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
      /** ADR-0113 — set when the duplicate is `doing`: "tab: …" / "session …". */
      duplicateHeldBy?: string;
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
      /** ADR-0113 — set when the duplicate is `doing`: "tab: …" / "session …". */
      duplicateHeldBy?: string;
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

// ---------------------------------------------------------------------------
// Layout — open items beside the index, resolved items in an archive
// (ADR-0044 addendum, 2026-11-27)
// ---------------------------------------------------------------------------
//
//   .marvin/backlog.md                  the index: open + doing + to-review only
//   .marvin/backlog/<slug>.md           one file per OPEN item (provisional, open, doing)
//   .marvin/backlog/archive/<slug>.md   one file per RESOLVED item (done, dismissed)
//   .marvin/backlog/archive/summary.json  {layout, done, dismissed} — the archive's counts
//
// One real project held 2,837 files in one directory, 2,544 of them resolved,
// and every reader — the pane, the session-start block, a sweep session — read
// all of them to find the 293 that matter. Now a reader of open work touches
// only the open files; the archive is read when someone asks for it, a page at
// a time. A write that changes an item's status moves its file.

const ARCHIVE_DIR = "archive";
const SUMMARY_FILE = "summary.json";
const LOCK_DIR = ".layout.lock";

function backlogDir(workDir: string): string {
  return join(workDir, ".marvin", "backlog");
}
function archiveDir(workDir: string): string {
  return join(backlogDir(workDir), ARCHIVE_DIR);
}
function indexFile(workDir: string): string {
  return join(workDir, ".marvin", "backlog.md");
}
function summaryFile(workDir: string): string {
  return join(archiveDir(workDir), SUMMARY_FILE);
}

/** done and dismissed live in the archive; everything else is open work. */
export function isResolvedStatus(s: BacklogStatus): boolean {
  return s === "done" || s === "dismissed";
}

/** A slug is a file name inside the store; anything that could leave it is not an id. */
function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && !id.includes("..");
}
function activePath(workDir: string, id: string): string {
  return join(backlogDir(workDir), `${id}.md`);
}
function archivePath(workDir: string, id: string): string {
  return join(archiveDir(workDir), `${id}.md`);
}

/** Where an item's file is now: the open directory first, then the archive. */
async function locate(workDir: string, id: string): Promise<{ path: string; archived: boolean } | null> {
  if (!validId(id)) return null;
  await ensureBacklogLayout(workDir);
  const active = activePath(workDir, id);
  if (existsSync(active)) return { path: active, archived: false };
  const archived = archivePath(workDir, id);
  if (existsSync(archived)) return { path: archived, archived: true };
  return null;
}

interface ArchiveSummary {
  layout: 1;
  done: number;
  dismissed: number;
}

async function readSummary(workDir: string): Promise<ArchiveSummary | null> {
  try {
    const raw = JSON.parse(await readFile(summaryFile(workDir), "utf-8")) as Partial<ArchiveSummary>;
    if (typeof raw.done !== "number" || typeof raw.dismissed !== "number") return null;
    return { layout: 1, done: Math.max(0, raw.done), dismissed: Math.max(0, raw.dismissed) };
  } catch {
    return null;
  }
}

async function writeSummary(workDir: string, s: ArchiveSummary): Promise<void> {
  await mkdir(archiveDir(workDir), { recursive: true });
  await writeFile(summaryFile(workDir), `${JSON.stringify(s)}\n`, "utf-8");
}

async function adjustSummary(workDir: string, delta: { done: number; dismissed: number }): Promise<void> {
  if (delta.done === 0 && delta.dismissed === 0) return;
  // No summary yet means the layout run has not happened: it (or the recount
  // that archiveCounts falls back to) computes the counts, so there is nothing to adjust.
  const cur = await readSummary(workDir);
  if (!cur) return;
  await writeSummary(workDir, { layout: 1, done: Math.max(0, cur.done + delta.done), dismissed: Math.max(0, cur.dismissed + delta.dismissed) });
}

/** Recount the archive from its files. Slow (reads them all) — only a layout run or a self-heal does it. */
async function recountArchive(workDir: string): Promise<ArchiveSummary> {
  let done = 0;
  let dismissed = 0;
  let names: string[] = [];
  try {
    names = (await readdir(archiveDir(workDir))).filter((f) => f.endsWith(".md"));
  } catch {
    /* no archive yet */
  }
  for (const f of names) {
    try {
      const st = frontmatterField(await readFile(join(archiveDir(workDir), f), "utf-8"), "status");
      if (st === "dismissed") dismissed += 1;
      else done += 1;
    } catch {
      /* unreadable: not counted */
    }
  }
  const s: ArchiveSummary = { layout: 1, done, dismissed };
  await writeSummary(workDir, s);
  return s;
}

/** How many resolved items the archive holds. The summary file answers; a file count that disagrees with it triggers a recount. */
export async function archiveCounts(workDir: string): Promise<{ done: number; dismissed: number }> {
  await ensureBacklogLayout(workDir);
  let files = 0;
  try {
    files = (await readdir(archiveDir(workDir))).filter((f) => f.endsWith(".md")).length;
  } catch {
    return { done: 0, dismissed: 0 };
  }
  const s = await readSummary(workDir);
  if (s && s.done + s.dismissed === files) return { done: s.done, dismissed: s.dismissed };
  const fresh = await recountArchive(workDir);
  return { done: fresh.done, dismissed: fresh.dismissed };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` holding the layout lock, or return null if the lock stays taken.
 * `mkdir` is the atomic test-and-set; a lock older than a minute is a crashed
 * holder's and is taken over. Two MARVIN sessions on one project (ADR-0102)
 * can both reach a migration; the moves below are idempotent as well, so the
 * lock is a courtesy to the disk, not the only thing keeping the store whole.
 */
async function withLayoutLock<T>(workDir: string, fn: () => Promise<T>): Promise<T | null> {
  const lock = join(backlogDir(workDir), LOCK_DIR);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
      try {
        if (Date.now() - (await lstat(lock)).mtimeMs > 60_000) {
          await rmdir(lock).catch(() => undefined);
          continue;
        }
      } catch {
        continue; // vanished between mkdir and lstat: the holder finished
      }
      if (Date.now() > deadline) return null;
      await sleep(50);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

const layoutReady = new Set<string>();

/** What `ensureBacklogLayout` did, for tests and the one-line log. */
export interface LayoutRun {
  migrated: boolean;
  moved: number;
  normalized: number;
  conflicts: number;
}

/**
 * Bring a project's backlog directory to the open-index + archive layout.
 *
 * Runs once per project: it is a no-op as soon as `archive/summary.json`
 * exists (and remembered per process, so the common call is a Set lookup).
 * Done and dismissed files MOVE, byte for byte — undoing it is
 * `mv .marvin/backlog/archive/*.md .marvin/backlog/` — and the open files are
 * rewritten once to carry `priority:` (the old `severity:` line stays beside it
 * so an older MARVIN still reads them). Idempotent and resumable: a run that
 * stops halfway finds the remaining files on the next one, because the summary
 * is written last.
 */
export async function ensureBacklogLayout(workDir: string): Promise<LayoutRun> {
  const none: LayoutRun = { migrated: false, moved: 0, normalized: 0, conflicts: 0 };
  if (layoutReady.has(workDir)) return none;
  const dir = backlogDir(workDir);
  if (!existsSync(dir)) return none; // nothing yet; the first write creates the store in the new layout
  if (existsSync(summaryFile(workDir))) {
    layoutReady.add(workDir);
    return none;
  }
  const run = await withLayoutLock(workDir, async (): Promise<LayoutRun> => {
    if (existsSync(summaryFile(workDir))) return none; // another session finished while we waited
    const out: LayoutRun = { migrated: true, moved: 0, normalized: 0, conflicts: 0 };
    await mkdir(archiveDir(workDir), { recursive: true });
    const adrIndex = await buildAdrIndex(workDir);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    for (const f of files) {
      try {
        const from = join(dir, f);
        const content = await readFile(from, "utf-8");
        const status = frontmatterField(content, "status");
        if (status === "done" || status === "dismissed") {
          const to = join(archiveDir(workDir), f);
          if (existsSync(to)) {
            // The same slug in both places (a half-finished earlier run, or a
            // checkout restoring an old file): keep both, name the older one
            // so nobody reads it as an item. Nothing is deleted.
            const [a, b] = await Promise.all([lstat(from), lstat(to)]);
            if (a.mtimeMs > b.mtimeMs) {
              await rename(to, `${to}.superseded`);
              await rename(from, to);
            } else {
              await rename(from, `${to}.superseded`);
            }
            out.conflicts += 1;
          } else {
            await rename(from, to);
          }
          out.moved += 1;
        } else if (!/^priority:/m.test(frontmatterOf(content))) {
          // An open item from before the field: rewrite it once, normalised.
          await writeFile(from, serialize(parseItem(f.replace(/\.md$/, ""), content), linkTrailerFor(content, workDir, adrIndex)), "utf-8");
          out.normalized += 1;
        }
      } catch {
        /* a file that cannot be read or moved stays where it is; the self-heal in readActive retries */
      }
    }
    await recountArchive(workDir); // writes summary.json — last, so a crash leaves the run resumable
    return out;
  });
  if (run === null) return none; // lock stayed taken: work in the old layout this call, try again next
  layoutReady.add(workDir);
  if (run.migrated) {
    try {
      await rewriteBacklogIndex(workDir);
    } catch {
      /* the index is rebuilt by the next write */
    }
  }
  return run;
}

/** Tests: forget which projects this process already laid out. */
export function resetBacklogLayoutCacheForTests(): void {
  layoutReady.clear();
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
  return /^(?:id|title|status|severity|priority|kind|blocked|blockedOn|sessionId|created|updated):\s/.test(
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

/** The frontmatter block only — a body line that happens to start `release:` is not a field. */
function frontmatterOf(content: string): string {
  const end = content.indexOf("\n---", 3);
  return end >= 0 ? content.slice(0, end) : content;
}

function frontmatterField(content: string, field: string): string {
  return parseField(frontmatterOf(content), field);
}

function parseItem(slug: string, content: string): BacklogItem {
  const bodyStart = content.indexOf("\n---", 3);
  const afterFm = bodyStart >= 0 ? content.indexOf("\n", bodyStart + 1) : -1;
  // The link trailer is DERIVED (ADR-0065 addendum) — strip it so it never
  // counts toward the body cap, never shows in the detail view's body field,
  // and never round-trips into itself on the next write.
  const body = stripLinkTrailer(afterFm >= 0 ? content.slice(afterFm + 1).trim() : "").trim();
  const fm = frontmatterOf(content);
  const statusRaw = parseField(fm, "status");
  // `priority:` first; a file written before 2026-11-27 only has `severity:`.
  const priorityRaw = parseField(fm, "priority") || parseField(fm, "severity");
  const kindRaw = parseField(fm, "kind");
  const typeRaw = parseField(fm, "type");
  const resolvedByRaw = parseField(fm, "resolvedBy");
  return {
    id: parseField(fm, "id") || slug,
    title: parseField(fm, "title") || slug,
    body,
    status: (BACKLOG_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as BacklogStatus)
      : "open",
    priority: normalizePriority(priorityRaw),
    // Absent in every file written before ADR-0064. Missing -> "unspecified"
    // rather than a guess: an invented kind would make filters silently wrong.
    kind: (BACKLOG_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as BacklogKind)
      : "unspecified",
    type: (BACKLOG_TYPES as readonly string[]).includes(typeRaw) ? (typeRaw as BacklogType) : "",
    release: parseField(fm, "release"),
    origin: parseField(fm, "origin"),
    waitsOn: parseField(fm, "waitsOn"),
    relatesTo: parseField(fm, "relatesTo"),
    resolvedBy: resolvedByRaw === "derived" ? "derived" : "",
    evidence: parseField(fm, "evidence"),
    reopenedAt: parseField(fm, "reopenedAt"),
    blocked: parseField(fm, "blocked") === "true",
    // Self-heal files corrupted by the old parser (see repairSwallowedField).
    blockedOn: repairSwallowedField(parseField(fm, "blockedOn")),
    sessionId: parseField(fm, "sessionId"),
    claimedBy: parseField(fm, "claimedBy"),
    claimedBranch: parseField(fm, "claimedBranch"),
    claimedAt: parseField(fm, "claimedAt"),
    created: parseField(fm, "created"),
    updated: parseField(fm, "updated"),
  };
}

/**
 * Write one item with its derived link trailer.
 *
 * Every write path goes through here so the trailer can never drift out of
 * sync with the body that produced it — and so the file always ends up where
 * its status says: a resolved item in the archive, anything else beside the
 * index. `adrIndex` is passed in when a caller is writing many items, so a
 * relink pass scans the ADR directory once rather than once per item.
 */
async function writeItem(
  workDir: string,
  item: BacklogItem,
  adrIndex?: AdrIndex,
): Promise<void> {
  await ensureBacklogLayout(workDir);
  const index = adrIndex ?? (await buildAdrIndex(workDir));
  const trailer = linkTrailerFor(`${item.title}\n${item.body}`, workDir, index);
  const toArchive = isResolvedStatus(item.status);
  const dest = toArchive ? archivePath(workDir, item.id) : activePath(workDir, item.id);
  const other = toArchive ? activePath(workDir, item.id) : archivePath(workDir, item.id);
  // The archive's counts follow the item: whatever the archive copy was, it is
  // no longer; whatever it is now, it is counted.
  const delta = { done: 0, dismissed: 0 };
  const before = existsSync(archivePath(workDir, item.id))
    ? frontmatterField(await readFile(archivePath(workDir, item.id), "utf-8").catch(() => ""), "status")
    : "";
  if (before === "done") delta.done -= 1;
  else if (before === "dismissed") delta.dismissed -= 1;
  else if (before) delta.done -= 1; // an archive file with no readable status was counted as done by the recount
  if (item.status === "done") delta.done += 1;
  if (item.status === "dismissed") delta.dismissed += 1;
  await mkdir(toArchive ? archiveDir(workDir) : backlogDir(workDir), { recursive: true });
  await writeFile(dest, serialize(item, trailer), "utf-8");
  await rm(other, { force: true });
  await adjustSummary(workDir, delta);
  // Say so (ADR-0044 addendum): every write path ends here, so every surface
  // that shows a backlog count hears about it — one debounced signal per project.
  noteBacklogWrite(workDir);
}

/**
 * Regenerate every live item's link trailer. Used when turning a project into a
 * vault: existing notes predate the trailer, so without this the graph stays
 * two starbursts until each item happens to be touched again.
 */
export async function relinkBacklogNotes(workDir: string): Promise<number> {
  const items = await readActive(workDir);
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
    `priority: ${item.priority}\n` +
    // The pre-2026-11-27 spelling, kept beside it: the macOS pane, the vault's
    // Dataview tables and an older MARVIN all still read `severity:`.
    `severity: ${legacySeverity(item.priority)}\n` +
    `kind: ${item.kind}\n` +
    (item.type ? `type: ${item.type}\n` : "") +
    (item.release ? `release: ${item.release}\n` : "") +
    (item.origin ? `origin: ${item.origin.replace(/\n/g, " ")}\n` : "") +
    (item.waitsOn ? `waitsOn: ${item.waitsOn.replace(/\n/g, " ")}\n` : "") +
    (item.relatesTo ? `relatesTo: ${item.relatesTo}\n` : "") +
    `blocked: ${item.blocked ? "true" : "false"}\n` +
    `blockedOn: ${item.blockedOn.replace(/\n/g, " ").trim()}\n` +
    `sessionId: ${item.sessionId}\n` +
    (item.claimedBy ? `claimedBy: ${item.claimedBy}\nclaimedBranch: ${item.claimedBranch}\nclaimedAt: ${item.claimedAt}\n` : "") +
    (item.resolvedBy ? `resolvedBy: ${item.resolvedBy}\n` : "") +
    (item.evidence ? `evidence: ${item.evidence}\n` : "") +
    (item.reopenedAt ? `reopenedAt: ${item.reopenedAt}\n` : "") +
    `created: ${item.created}\n` +
    `updated: ${item.updated}\n` +
    `---\n\n${item.body || item.title}\n${linkTrailer}`
  );
}

/** The open items: every file beside the index. A resolved file found there (an older MARVIN wrote it, a checkout restored it) is moved to the archive on the spot. */
async function readActive(workDir: string): Promise<BacklogItem[]> {
  await ensureBacklogLayout(workDir);
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
      const item = parseItem(f.replace(/\.md$/, ""), content);
      if (isResolvedStatus(item.status)) {
        if (!existsSync(archivePath(workDir, item.id))) {
          await mkdir(archiveDir(workDir), { recursive: true });
          await rename(join(dir, f), archivePath(workDir, item.id));
          await adjustSummary(workDir, { done: item.status === "done" ? 1 : 0, dismissed: item.status === "dismissed" ? 1 : 0 });
        }
        continue;
      }
      items.push(item);
    } catch {
      /* skip unreadable */
    }
  }
  return items;
}

/** One item by id, wherever it lives — open directory or archive. */
export async function getBacklogItem(workDir: string, id: string): Promise<BacklogItem | null> {
  const loc = await locate(workDir, id);
  if (!loc) return null;
  try {
    return parseItem(id, await readFile(loc.path, "utf-8"));
  } catch {
    return null;
  }
}

export interface ResolvedPage {
  items: BacklogItem[];
  /** Resolved items matching the status filter (from the archive's summary, not a scan). */
  total: number;
  offset: number;
  hasMore: boolean;
}

/**
 * A page of resolved items, newest first (by when the file was last written —
 * which is when it was resolved). Reads only the files of the page: the names
 * and mtimes are one `readdir` + `lstat` per file; the bodies are not touched.
 */
export async function listResolved(
  workDir: string,
  opts: { status?: "done" | "dismissed"; limit?: number; offset?: number } = {},
): Promise<ResolvedPage> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const counts = await archiveCounts(workDir);
  const total = opts.status ? counts[opts.status] : counts.done + counts.dismissed;
  const dir = archiveDir(workDir);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return { items: [], total: 0, offset, hasMore: false };
  }
  const stamped: Array<{ name: string; mtime: number }> = [];
  for (let i = 0; i < names.length; i += 64) {
    const chunk = names.slice(i, i + 64);
    const rows = await Promise.all(
      chunk.map(async (name) => {
        try {
          return { name, mtime: (await lstat(join(dir, name))).mtimeMs };
        } catch {
          return null;
        }
      }),
    );
    for (const r of rows) if (r) stamped.push(r);
  }
  stamped.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const items: BacklogItem[] = [];
  let seen = 0;
  let more = false;
  for (const { name } of stamped) {
    let item: BacklogItem;
    try {
      item = parseItem(name.replace(/\.md$/, ""), await readFile(join(dir, name), "utf-8"));
    } catch {
      continue;
    }
    if (opts.status && item.status !== opts.status) continue;
    if (seen++ < offset) continue;
    if (items.length >= limit) {
      more = true;
      break;
    }
    items.push(item);
  }
  return { items, total, offset, hasMore: more };
}

const STATUS_MARK: Record<BacklogStatus, string> = {
  provisional: "[?]",
  open: "[ ]",
  doing: "[~]",
  done: "[x]",
  dismissed: "[-]",
};

const PRIORITY_ORDER: Record<BacklogPriority, number> = { high: 0, medium: 1, low: 2 };

/**
 * Rebuild `.marvin/backlog.md` from the open files. Lists only open + doing +
 * to-review (active work), one compact line each; resolved items are in the
 * archive and named by a count. Returns the active count.
 */
export async function rewriteBacklogIndex(workDir: string): Promise<number> {
  // Active rail = provisional + open + doing. Provisional items (ADR-0047) are
  // listed too so an auto-captured discovery resurfaces next session even if it
  // was never reviewed — losing it is the failure this exists to prevent.
  const active = (await readActive(workDir)).sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.created.localeCompare(b.created),
  );
  const lines = active.map((i) => {
    const meta = [i.type, i.release, i.waitsOn ? `waits on ${i.waitsOn}` : ""].filter(Boolean);
    // `[[backlog/<id>]]` rather than a bare path: Obsidian resolves it to the
    // note, which is what connects the index to its items in the graph view
    // (ADR-0065). Without links the vault is N disconnected dots. Reads the
    // same as the old text form everywhere else, including the context
    // injection that quotes this file.
    return `- ${STATUS_MARK[i.status]} (${i.priority}) ${i.title}${i.status === "doing" && describeClaim(i) ? ` · ${describeClaim(i)}` : ""}${meta.length ? ` · ${meta.join(" · ")}` : ""} — [[backlog/${i.id}]]`;
  });
  const archived = await archiveCounts(workDir);
  const archivedTotal = archived.done + archived.dismissed;
  const body =
    `${INDEX_HEADER}\n\n` +
    `Parked follow-ups (open + in-progress; \`[?]\` = auto-captured, awaiting your ` +
    `keep/dismiss). One line per item; details in \`.marvin/backlog/<slug>.md\`. ` +
    `A PARKING LOT, not a queue agents pull from (ADR-0044) — resolve via the ` +
    `\`backlog_resolve\` tool or the backlog panel.${archivedTotal ? ` ${archivedTotal} resolved items are archived in \`.marvin/backlog/archive/\` — \`backlog_list status: done | dismissed | all\` reads them.` : ""}\n\n` +
    (lines.length ? lines.join("\n") : "_No open backlog items._") +
    "\n";
  await mkdir(join(workDir, ".marvin"), { recursive: true });
  await writeFile(indexFile(workDir), body, "utf-8");
  return active.length;
}

/**
 * The backlog's items. By default the OPEN ones (provisional, open, doing) —
 * the archive is not read unless asked: `status: "done" | "dismissed"` reads
 * it whole (prefer `listResolved`, which pages), `"all"` returns both.
 */
export async function listBacklog(
  workDir: string,
  opts?: { status?: BacklogStatus | "all" },
): Promise<BacklogItem[]> {
  const status = opts?.status;
  if (status === "done" || status === "dismissed") {
    const out: BacklogItem[] = [];
    for (let offset = 0; ; ) {
      const page = await listResolved(workDir, { status, limit: 500, offset });
      out.push(...page.items);
      if (!page.hasMore) return out;
      offset += page.items.length;
    }
  }
  const active = await readActive(workDir);
  if (status === "all") {
    const resolved = await listBacklog(workDir, { status: "done" });
    const dismissed = await listBacklog(workDir, { status: "dismissed" });
    return [...active, ...resolved, ...dismissed];
  }
  return status ? active.filter((i) => i.status === status) : active;
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
  const addLimit = bodyLimitError(body);
  if (addLimit) return { ok: false, error: addLimit };
  let priority: BacklogPriority = "medium";
  if (input.priority !== undefined) {
    const p = parsePriority(input.priority);
    if (!p.ok) return { ok: false, error: p.error };
    priority = p.value;
  }
  if (input.type !== undefined && !(BACKLOG_TYPES as readonly string[]).includes(input.type)) {
    return { ok: false, error: `type ${JSON.stringify(input.type)} is not valid — use one of ${BACKLOG_TYPES.join(", ")}. Nothing was written.` };
  }
  const release = lineField("release", input.release, MAX_RELEASE_CHARS);
  if (!release.ok) return release;
  const origin = lineField("origin", input.origin, MAX_ORIGIN_CHARS);
  if (!origin.ok) return origin;
  const waitsOn = lineField("waitsOn", input.waitsOn, MAX_WAITS_ON_CHARS);
  if (!waitsOn.ok) return waitsOn;
  const slug = slugify(title);
  let relatesTo = "";
  if (input.relatesTo?.trim()) {
    relatesTo = input.relatesTo.trim();
    if (relatesTo === slug) return { ok: false, error: "relatesTo names this item itself. Nothing was written." };
    if (!(await locate(workDir, relatesTo))) {
      return { ok: false, error: `relatesTo "${relatesTo}" is not a backlog item (open or archived) — pass the slug from backlog_list. Nothing was written.` };
    }
  }
  const dir = backlogDir(workDir);
  const now = new Date().toISOString();

  const loc = await locate(workDir, slug);
  const existing = loc ? parseItem(slug, await readFile(loc.path, "utf-8")) : null;

  // Read once and reuse for both the open-count rail and overlap detection.
  const all = await readActive(workDir);

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
  // ADR-0113 — the same slug parked again while ANOTHER tab holds it: say who,
  // change nothing. (Same tab re-parking its own item still updates it.)
  if (existing && existing.status === "doing" && existing.claimedBy && existing.claimedBy !== (input.sessionId ?? "")) {
    return {
      ok: true,
      item: existing,
      created: false,
      related: relatedBacklogItems(existing, all),
      duplicateOf: existing.id,
      duplicateHeldBy: describeClaim(existing) ?? "another session",
    };
  }
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
  const reopening = !!existing && isResolvedStatus(existing.status);

  const item: BacklogItem = {
    id: slug,
    title,
    body,
    status,
    priority,
    // An omitted kind KEEPS what's there rather than resetting to unspecified —
    // a re-add (or a provisional confirm) must not wipe a classification the
    // user made in the panel. The same goes for every optional field below.
    kind: input.kind ?? existing?.kind ?? "unspecified",
    type: input.type ?? existing?.type ?? "",
    release: input.release !== undefined ? release.value : (existing?.release ?? ""),
    origin: input.origin !== undefined ? origin.value : (existing?.origin ?? ""),
    waitsOn: input.waitsOn !== undefined ? waitsOn.value : (existing?.waitsOn ?? ""),
    relatesTo: relatesTo || (existing?.relatesTo ?? ""),
    resolvedBy: reopening ? "" : (existing?.resolvedBy ?? ""),
    evidence: reopening ? "" : (existing?.evidence ?? ""),
    reopenedAt: reopening ? now : (existing?.reopenedAt ?? ""),
    blocked: input.blocked ?? existing?.blocked ?? false,
    blockedOn: (input.blockedOn ?? existing?.blockedOn ?? "").trim().slice(0, 200),
    sessionId: input.sessionId ?? existing?.sessionId ?? "",
    claimedBy: existing?.claimedBy ?? "",
    claimedBranch: existing?.claimedBranch ?? "",
    claimedAt: existing?.claimedAt ?? "",
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
      // ADR-0113 — a duplicate of an item someone is WORKING is the sentence
      // that stops a second fix: name the holder.
      const heldBy = dupe.status === "doing" ? describeClaim(dupe) : null;
      return { ok: true, item: dupe, created: false, related, duplicateOf: dupe.id, ...(heldBy ? { duplicateHeldBy: heldBy } : {}) };
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
  return { ok: true, item: res.item, related: relatedBacklogItems(res.item, await readActive(workDir)) };
}

/** Id-keyed field edit — priority and/or body REPLACE (unlike the
 *  note-append in `setBacklogStatus`). Title is deliberately not
 *  editable: the slug/id/filename derive from it, so a rename is a
 *  new item, not an edit. Used by the UI's backlog detail view. */
export async function updateBacklogItem(
  workDir: string,
  id: string,
  fields: {
    priority?: BacklogPriority;
    body?: string;
    kind?: BacklogKind;
    type?: BacklogType;
    release?: string;
    origin?: string;
    waitsOn?: string;
    blocked?: boolean;
    blockedOn?: string;
    /** Append a dated `> note` line without changing status or claim. */
    note?: string;
  },
  now: Date = new Date(),
): Promise<ResolveResult> {
  const loc = await locate(workDir, id);
  if (!loc) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(loc.path, "utf-8"));
  if (fields.priority !== undefined) {
    const p = parsePriority(fields.priority);
    if (!p.ok) return { ok: false, error: p.error };
    fields = { ...fields, priority: p.value };
  }
  if (fields.type !== undefined && !(BACKLOG_TYPES as readonly string[]).includes(fields.type)) {
    return { ok: false, error: `type ${JSON.stringify(fields.type)} is not valid — use one of ${BACKLOG_TYPES.join(", ")}. Nothing was written.` };
  }
  const release = fields.release !== undefined ? lineField("release", fields.release, MAX_RELEASE_CHARS) : null;
  if (release && !release.ok) return release;
  const origin = fields.origin !== undefined ? lineField("origin", fields.origin, MAX_ORIGIN_CHARS) : null;
  if (origin && !origin.ok) return origin;
  const waitsOn = fields.waitsOn !== undefined ? lineField("waitsOn", fields.waitsOn, MAX_WAITS_ON_CHARS) : null;
  if (waitsOn && !waitsOn.ok) return waitsOn;
  if (fields.note !== undefined && fields.note.trim()) {
    const base = fields.body !== undefined ? fields.body.trim() : item.body;
    fields = { ...fields, body: `${base}\n\n> note ${now.toISOString().slice(0, 10)} — ${fields.note.trim()}`.trim() };
  }
  // Refuse, never truncate: a silent `.slice` cut real item text mid-word
  // (2026-09-28). The caller condenses (or files a follow-up) and retries;
  // nothing is written.
  const updateLimit = fields.body !== undefined ? bodyLimitError(fields.body.trim(), id) : null;
  if (updateLimit) return { ok: false, error: updateLimit };
  if (fields.priority !== undefined) item.priority = fields.priority;
  if (fields.body !== undefined) item.body = fields.body.trim();
  if (fields.kind !== undefined) item.kind = fields.kind;
  if (fields.type !== undefined) item.type = fields.type;
  if (release?.ok) item.release = release.value;
  if (origin?.ok) item.origin = origin.value;
  if (waitsOn?.ok) item.waitsOn = waitsOn.value;
  if (fields.blocked !== undefined) item.blocked = fields.blocked;
  if (fields.blockedOn !== undefined) item.blockedOn = fields.blockedOn.trim().slice(0, 200);
  // `updated` drives STALENESS, so only a change to the WORK counts as touching
  // it. Labelling an item is not engaging with it: a classification pass over a
  // whole backlog would otherwise reset every staleness clock at once and blind
  // the groomer for a month. Observed 2026-08-14 — classifying 58 items made
  // all 9 stale findings and every aging-bug vanish, which read like the new
  // exemptions working when it was really the timestamps being clobbered.
  const touchedWork = fields.body !== undefined || fields.priority !== undefined;
  if (touchedWork) item.updated = new Date().toISOString();
  try {
    await writeItem(workDir, item);
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to update backlog item: ${(err as Error).message}` };
  }
}

/**
 * ADR-0113 — take an item: open or provisional → doing, with the caller as
 * holder. A second claimant is refused and told who holds it; the same
 * session re-claiming (a resumed tab) is a no-op that succeeds.
 */
export type ClaimResult =
  | { ok: true; item: BacklogItem; alreadyHeld: boolean }
  | { ok: false; error: string; holder?: string; holderSessionId?: string };

export async function claimBacklogItem(
  workDir: string,
  id: string,
  claim: BacklogClaim,
  now = new Date().toISOString(),
): Promise<ClaimResult> {
  const loc = await locate(workDir, id);
  if (!loc) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(loc.path, "utf-8"));
  if (item.status === "done" || item.status === "dismissed") {
    return { ok: false, error: `backlog item "${id}" is ${item.status}; reopen it (backlog_resolve keep) before claiming.` };
  }
  if (item.status === "doing" && item.claimedBy && item.claimedBy !== claim.sessionId) {
    const holder = describeClaim(item) ?? "another session";
    return { ok: false, error: `backlog item "${id}" is already being worked (${holder}).`, holder, holderSessionId: item.claimedBy };
  }
  const alreadyHeld = item.status === "doing" && item.claimedBy === claim.sessionId;
  item.status = "doing";
  item.claimedBy = claim.sessionId;
  item.claimedBranch = claim.branch ?? item.claimedBranch ?? "";
  if (!alreadyHeld) item.claimedAt = now;
  item.updated = now;
  try {
    await writeItem(workDir, item);
    await rewriteBacklogIndex(workDir);
    return { ok: true, item, alreadyHeld };
  } catch (err) {
    return { ok: false, error: `failed to claim backlog item: ${(err as Error).message}` };
  }
}

/** ADR-0113 — the branch a claim is on became known after the claim (a tab's first message cut it). */
export async function noteClaimBranch(workDir: string, sessionId: string, branch: string): Promise<number> {
  let n = 0;
  for (const item of await readActive(workDir)) {
    if (item.status === "doing" && item.claimedBy === sessionId && item.claimedBranch !== branch) {
      item.claimedBranch = branch;
      try {
        await writeItem(workDir, item);
        n += 1;
      } catch {
        /* best-effort */
      }
    }
  }
  if (n) await rewriteBacklogIndex(workDir);
  return n;
}

/** Set any status (e.g. `doing` when promoted to a turn). Rewrites the index.
 *  ADR-0113 — any status other than `doing` releases the claim; `doing` with
 *  a `claim` records the holder (the panel's Plan), without one keeps whatever
 *  holder there was. A resolved item's file moves to the archive; reopening
 *  one (`open`, `provisional`, `doing`) brings it back. */
export async function setBacklogStatus(
  workDir: string,
  id: string,
  status: BacklogStatus,
  note?: string,
  claim?: BacklogClaim,
): Promise<ResolveResult> {
  const loc = await locate(workDir, id);
  if (!loc) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(loc.path, "utf-8"));
  // Refuse, never truncate: appending a note used to `.slice` the whole body
  // to the cap, so on an item near it the note vanished or the tail was cut
  // (2026-09-28, the Dxx stage items). Checked before anything is changed.
  const withNote = note && note.trim() ? `${item.body}\n\n> ${status} — ${note.trim()}`.trim() : null;
  const noteLimit = withNote !== null ? bodyLimitError(withNote, id) : null;
  if (noteLimit) return { ok: false, error: `adding this note: ${noteLimit}` };
  const wasResolved = isResolvedStatus(item.status);
  item.status = status;
  item.updated = new Date().toISOString();
  // Whoever resolves or reopens by hand replaces what git derived.
  item.resolvedBy = "";
  item.evidence = "";
  if (wasResolved && !isResolvedStatus(status)) item.reopenedAt = item.updated;
  if (status !== "doing") {
    item.claimedBy = "";
    item.claimedBranch = "";
    item.claimedAt = "";
  } else if (claim) {
    item.claimedBy = claim.sessionId;
    item.claimedBranch = claim.branch ?? "";
    item.claimedAt = item.updated;
  }
  if (withNote !== null) item.body = withNote;
  try {
    await writeItem(workDir, item);
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to update backlog item: ${(err as Error).message}` };
  }
}

/**
 * Close an open or doing item because git says its fix is on the project's
 * branch (`backlog-derive.ts`). Persisted as an ordinary resolution — status
 * `done`, the file in the archive — plus `resolvedBy: derived` and the commit
 * sha as `evidence`, so the derivation is never repeated. The note is best
 * effort: an item whose notes are full is still resolved, its evidence lives in
 * the frontmatter.
 */
export async function resolveDerivedBacklogItem(
  workDir: string,
  id: string,
  evidence: { sha: string; subject: string; branch: string },
): Promise<ResolveResult> {
  const loc = await locate(workDir, id);
  if (!loc || loc.archived) return { ok: false, error: `no open backlog item "${id}".` };
  const item = parseItem(id, await readFile(loc.path, "utf-8"));
  if (item.status !== "open" && item.status !== "doing") return { ok: false, error: `backlog item "${id}" is ${item.status}, not open.` };
  const note = `> done — derived: commit ${evidence.sha.slice(0, 12)} "${evidence.subject.slice(0, 90)}" carries \`Backlog: ${id}\` and is on ${evidence.branch}.`;
  const withNote = `${item.body}\n\n${note}`.trim();
  if (!bodyLimitError(withNote, id)) item.body = withNote;
  item.status = "done";
  item.resolvedBy = "derived";
  item.evidence = evidence.sha;
  item.updated = new Date().toISOString();
  item.claimedBy = "";
  item.claimedBranch = "";
  item.claimedAt = "";
  try {
    await writeItem(workDir, item);
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to resolve backlog item: ${(err as Error).message}` };
  }
}
