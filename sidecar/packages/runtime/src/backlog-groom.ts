/**
 * Backlog groomer (ADR-0063) — Phase 1 of the backlog loop.
 *
 * A backlog that only ever grows stops being read. Capture is un-gated at
 * discovery (ADR-0047), so items accumulate by design: near-duplicates the
 * exact-slug dedup can't see, provisional captures nobody ever reviewed, open
 * items whose work quietly landed months ago, references to files that no
 * longer exist. The open rail went 50 → 200 because a real project hit 50
 * through ordinary use — the rail was the symptom, not the problem.
 *
 * This is the REVIEW half of "review the backlog and work on it". It reads the
 * backlog and reports what looks wrong. It does not fix anything.
 *
 * ## Why it only reports
 *
 * Every judgement here is heuristic. "Untouched for 30 days" is not "abandoned";
 * "these two look alike" is not "these are the same"; "that file is gone" is not
 * "that work is done" (the file may have moved, or the item may be the request
 * to create it). Acting on a heuristic would resolve work nobody agreed to drop
 * — the exact evaporation the backlog exists to prevent, and the reason
 * ADR-0044's addendum made overlap detection surface-only.
 *
 * So the contract matches that precedent: the groomer produces findings with
 * SUGGESTIONS, MARVIN relays them, and the user decides. Anthropic's
 * long-running-agent guidance points the same way — the failure mode they
 * document is an agent marking work complete on its own judgement rather than
 * against a structured, external stopping condition.
 *
 * Autonomous EXECUTION of backlog items (Phase 2) is deliberately not part of
 * this: it needs an amendment to ADR-0044 §5 and a per-item authorisation
 * state, neither of which exists yet.
 *
 * Pure — `now` and file existence are injected, so every threshold is testable
 * without a clock or a filesystem.
 */

import {
  extractPathRefs,
  relatedBacklogItems,
  type BacklogItem,
  type BacklogSeverity,
} from "./backlog";

/** Statuses that can still be acted on. Resolved items are history. */
const LIVE = new Set(["provisional", "open", "doing"]);

export type GroomFindingKind =
  /** Two or more live items that look like the same work. */
  | "duplicate"
  /** Auto-captured (ADR-0047) and never keep/dismissed. */
  | "unreviewed"
  /** Live, but untouched long enough to doubt it's still wanted. */
  | "stale"
  /** Names a file that no longer exists — the work may have landed. */
  | "dangling-reference"
  /** Filed as high severity and then left alone, which is a contradiction. */
  | "aging-high-severity";

export interface GroomFinding {
  kind: GroomFindingKind;
  /** The item the finding is about. */
  item: BacklogItem;
  /** Other items involved — populated for `duplicate`. */
  related: BacklogItem[];
  /** What was observed, in one user-facing line. */
  detail: string;
  /** What the USER might do about it. Never applied automatically. */
  suggestion: string;
}

export interface GroomReport {
  /** Every item in the store, including resolved. */
  scanned: number;
  /** Provisional + open + doing. */
  live: number;
  findings: GroomFinding[];
  /** True when findings were capped — say so rather than imply a clean sweep. */
  truncated: boolean;
}

export interface GroomOptions {
  /** Injected so thresholds are testable without a clock. */
  now: Date;
  /** Live + untouched for this long → `stale`. */
  staleDays?: number;
  /** Provisional + never reviewed for this long → `unreviewed`. */
  unreviewedDays?: number;
  /** High severity + open this long → `aging-high-severity`. */
  highSeverityDays?: number;
  /** Cap — a report nobody finishes reading is a report nobody acts on. */
  maxFindings?: number;
  /**
   * Does this path (as written in the item) still exist? Omit to skip the
   * dangling-reference check entirely — better to run one fewer check than to
   * report every path as missing because the caller had no workdir.
   */
  fileExists?: (pathRef: string) => boolean;
}

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_UNREVIEWED_DAYS = 7;
const DEFAULT_HIGH_SEVERITY_DAYS = 14;
const DEFAULT_MAX_FINDINGS = 25;

/** Findings are emitted in this order — most actionable first. */
const KIND_ORDER: GroomFindingKind[] = [
  "duplicate",
  "dangling-reference",
  "unreviewed",
  "aging-high-severity",
  "stale",
];

const SEVERITY_RANK: Record<BacklogSeverity, number> = { high: 0, med: 1, low: 2 };

function daysBetween(now: Date, iso: string): number | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (now.getTime() - then) / 86_400_000;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Analyse the backlog and report what looks wrong. Never mutates; the caller
 * renders the findings for the user.
 */
export function groomBacklog(items: BacklogItem[], opts: GroomOptions): GroomReport {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const unreviewedDays = opts.unreviewedDays ?? DEFAULT_UNREVIEWED_DAYS;
  const highSeverityDays = opts.highSeverityDays ?? DEFAULT_HIGH_SEVERITY_DAYS;
  const maxFindings = opts.maxFindings ?? DEFAULT_MAX_FINDINGS;

  const live = items.filter((i) => LIVE.has(i.status));
  const findings: GroomFinding[] = [];

  // ── Duplicates ──────────────────────────────────────────────────────────
  // Reported ONCE per cluster. Without this the same pair shows up twice, from
  // each side, and a report that repeats itself reads as noise.
  const clustered = new Set<string>();
  for (const item of live) {
    if (clustered.has(item.id)) continue;
    const related = relatedBacklogItems(item, live);
    if (related.length === 0) continue;
    clustered.add(item.id);
    for (const r of related) clustered.add(r.id);
    findings.push({
      kind: "duplicate",
      item,
      related,
      detail: `looks like the same work as ${plural(related.length, "other item")}: ${related
        .map((r) => `\`${r.id}\``)
        .join(", ")}`,
      suggestion: "merge into one item, or resolve the ones already covered",
    });
  }

  // ── Per-item checks ─────────────────────────────────────────────────────
  for (const item of live) {
    const ageCreated = daysBetween(opts.now, item.created);
    const ageUpdated = daysBetween(opts.now, item.updated);

    if (item.status === "provisional" && ageCreated !== null && ageCreated >= unreviewedDays) {
      findings.push({
        kind: "unreviewed",
        item,
        related: [],
        detail: `auto-captured ${Math.floor(ageCreated)} days ago and never reviewed`,
        suggestion: "keep it (→ open) or dismiss it",
      });
    }

    if (opts.fileExists) {
      // Only paths written WITH a directory component. A bare "README.md"
      // can't be resolved to one file, and guessing would report phantoms.
      const missing = [...new Set(extractPathRefs(`${item.title}\n${item.body}`))]
        .filter((p) => p.includes("/") && !opts.fileExists!(p));
      if (missing.length > 0) {
        findings.push({
          kind: "dangling-reference",
          item,
          related: [],
          detail: `references ${missing.length === 1 ? "a file" : "files"} that no longer exist: ${missing
            .map((p) => `\`${p}\``)
            .join(", ")}`,
          suggestion: "check whether this work already landed, or the path moved",
        });
      }
    }

    if (
      item.severity === "high" &&
      item.status === "open" &&
      ageCreated !== null &&
      ageCreated >= highSeverityDays
    ) {
      findings.push({
        kind: "aging-high-severity",
        item,
        related: [],
        detail: `filed HIGH ${Math.floor(ageCreated)} days ago and still untouched`,
        suggestion: "do it now, or downgrade — a high that sits is mislabelled",
      });
    }

    // Staleness last: it's the weakest signal, and an item already flagged for
    // a concrete reason doesn't need "and it's also old" appended.
    if (
      ageUpdated !== null &&
      ageUpdated >= staleDays &&
      !findings.some((f) => f.item.id === item.id)
    ) {
      findings.push({
        kind: "stale",
        item,
        related: [],
        detail: `untouched for ${Math.floor(ageUpdated)} days`,
        suggestion: "still wanted? resolve it or leave a note on why it's parked",
      });
    }
  }

  findings.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] ||
      a.item.id.localeCompare(b.item.id),
  );

  return {
    scanned: items.length,
    live: live.length,
    findings: findings.slice(0, maxFindings),
    truncated: findings.length > maxFindings,
  };
}

/**
 * Render a report for the model to relay.
 *
 * Phrased throughout as observations and questions for the USER — never as
 * instructions to the model. A report that reads like a task list invites
 * exactly the auto-application this design rules out.
 */
export function renderGroomReport(report: GroomReport): string {
  if (report.findings.length === 0) {
    return (
      `Backlog looks healthy — ${report.live} live of ${report.scanned} total, ` +
      `nothing stale, duplicated, or unreviewed.`
    );
  }
  const lines = report.findings.map(
    (f) => `- [${f.kind}] \`${f.item.id}\` (${f.item.severity}) — ${f.detail}. → ${f.suggestion}`,
  );
  return (
    `Backlog groom — ${report.live} live of ${report.scanned} total, ` +
    `${plural(report.findings.length, "finding")}` +
    (report.truncated ? ` (capped; more remain)` : "") +
    `:\n${lines.join("\n")}\n\n` +
    `These are HEURISTICS, not conclusions — relay them and let the user decide. ` +
    `Do not resolve, merge, re-prioritise, or edit any item on the strength of ` +
    `this report alone.`
  );
}
