/**
 * Server-side plan-spine projection (ADR-0116).
 *
 * ADR-0052 made the spine durable, but left the CLIENT as its only writer:
 * the Swift app ingests each `TodoWrite` off the live event stream, reconciles
 * it into `plans`, and PUTs the result. The sidecar only ever read it back.
 *
 * That is a client-derived record of a server-driven process. A turn nobody is
 * watching — a scheduled wakeup (ADR-0031), a background-job completion
 * (ADR-0038), any turn that runs while another tab is on screen — advances the
 * work and cannot advance the plan. Measured on a real session (2026-09-11):
 * the spine froze at the last `TodoWrite` of the last turn the user typed into,
 * and the five that followed, across four wakeup turns, were lost. The plan
 * read 8/14 while the executor had shipped all fourteen steps and three
 * commits.
 *
 * This module is the server's half. It applies a `TodoWrite` batch to the
 * stored spine using ONLY the deterministic `[N]` tag join (ADR-0049), so
 * progress is recorded whether or not a client is attached.
 *
 * ## What it deliberately does NOT do
 *
 * No fuzzy content matching, no sub-task nesting, no upward roll-up, no
 * ADR-0106 supersession. Those live once, in Swift (`PlanModel.swift`), and a
 * second implementation of them here would be two places for one thing
 * (ADR-0112) — the kind of drift that produces two defensible answers to
 * "is this step done". The server moves top-level step STATUS by ordinal and
 * nothing else; structure stays the client's.
 *
 * The consequence is chosen: when a batch can't be joined by tag, the server
 * leaves the spine untouched and the step stays open. An unmarked box costs
 * one honest reconciliation turn (ADR-0057); a falsely ticked one costs the
 * user their trust in the plan.
 */

/** A parsed `[N]` / `[N-M]` / `[N.M]` prefix. Mirrors `PlanTag.parseFull`. */
export interface PlanTagParse {
  /** First addressed step, 1-based. */
  lo: number;
  /** Last addressed step, 1-based (equal to `lo` for a single ordinal). */
  hi: number;
  /** Sub-task key for `[N.M]`, else null. A range never carries one. */
  sub: string | null;
  /** Content with the tag stripped. */
  text: string;
}

/** Same grammar as the Swift `PlanTag.re` — keep the two in lockstep. */
const TAG_RE = /^\s*\[(\d+)(?:\s*[-–]\s*(\d+))?(?:\.([0-9A-Za-z][0-9A-Za-z.]*))?\]\s*(.*)$/;

export function parsePlanTag(content: string): PlanTagParse | null {
  const m = TAG_RE.exec(content);
  if (!m) return null;
  const lo = Number.parseInt(m[1] as string, 10);
  const hi = m[2] ? Number.parseInt(m[2], 10) : lo;
  const sub = m[3] ?? null;
  // A descending range, or a range carrying a sub-key, is not a tag we
  // understand — `[3-1]` and `[3-8.1]` read as untagged prose.
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  if (sub !== null && hi !== lo) return null;
  const text = (m[4] ?? "").trim();
  return { lo, hi, sub, text: text || content };
}

interface RawTodo {
  content?: unknown;
  status?: unknown;
}

/** The `[N]` ordinals a batch marks `completed`, de-duplicated and sorted. */
export function stepsClosedByBatch(todos: unknown): number[] {
  const out = new Set<number>();
  for (const t of topLevelTagged(todos)) {
    if (t.status !== "completed") continue;
    for (let s = t.tag.lo; s <= t.tag.hi; s++) out.add(s);
  }
  return [...out].sort((a, b) => a - b);
}

interface TaggedTodo {
  tag: PlanTagParse;
  status: string;
}

/** Top-level (`[N]`, no sub-key) rows of a batch, in batch order. */
function topLevelTagged(todos: unknown): TaggedTodo[] {
  if (!Array.isArray(todos)) return [];
  const out: TaggedTodo[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as RawTodo;
    if (typeof t.content !== "string") continue;
    const tag = parsePlanTag(t.content);
    if (!tag || tag.sub !== null) continue;
    out.push({ tag, status: typeof t.status === "string" ? t.status : "pending" });
  }
  return out;
}

/** Minimum tagged rows before the re-base signature may fire (ADR-0052). */
export const REBASE_MIN_BATCH = 3;

/**
 * True when a batch's `[N]` ordinals look re-based against a foreign list —
 * tags exactly `1..K` for a K that disagrees with the plan's step count. The
 * model renumbered after an interruption and the ordinals are lies; trusting
 * them overwrites unrelated steps.
 *
 * The Swift guard adds a third signature (do the tagged texts relate to the
 * steps they address). That one needs the text matcher, which stays in one
 * place, so this side distrusts on the arithmetic alone. It is therefore
 * STRICTLY more conservative than the client: a batch the client would have
 * trusted may be skipped here, which leaves a step open and costs one
 * reconciliation turn. It never closes a step the client would not have.
 */
export function looksRebased(taggedSteps: number[], stepCount: number): boolean {
  if (taggedSteps.length < REBASE_MIN_BATCH || stepCount === 0) return false;
  const sorted = [...taggedSteps].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) return false;
  }
  return taggedSteps.length !== stepCount;
}

export interface SpineApplyResult {
  /** The spine to persist. Identical object when nothing was applied. */
  state: unknown;
  /**
   * True when the batch was joinable — a tagged, trusted batch addressed to a
   * live plan. The caller persists on this, not on `changed`: a batch that
   * restated the same statuses still moves the watermark, and the watermark is
   * what tells a hydrating client the server has already seen this far.
   */
  joined: boolean;
  /** True when at least one step's status actually moved. */
  changed: boolean;
  /** How many top-level `[N]` rows the batch carried. */
  taggedRows: number;
  /** Batch rows in total (tagged or not). */
  totalRows: number;
  /** True when the batch was skipped as re-based. */
  distrusted: boolean;
}

interface MutableStep {
  status?: unknown;
  activeForm?: unknown;
  [k: string]: unknown;
}

interface MutablePlan {
  id?: unknown;
  steps?: unknown;
  [k: string]: unknown;
}

/**
 * Apply a `TodoWrite` batch to the stored spine by `[N]` tag.
 *
 * Only the ACTIVE plan is touched — a batch addresses the plan the executor is
 * working, and ordinals mean nothing against any other. Only top-level step
 * `status` moves; `subtasks`, `content`, `text`, `path` and every other field
 * are carried through untouched, so a client that later reconciles the same
 * batch still owns structure.
 *
 * Fully defensive: any deviation from the expected shape returns the input
 * state unchanged rather than throwing. The spine is written by the client and
 * is the client's model — this side must never be the reason hydration breaks.
 */
export function applyTodosToSpine(state: unknown, todos: unknown, at: string): SpineApplyResult {
  const unchanged = (distrusted = false, taggedRows = 0, totalRows = 0): SpineApplyResult => ({
    state,
    joined: false,
    changed: false,
    taggedRows,
    totalRows,
    distrusted,
  });

  if (!state || typeof state !== "object") return unchanged();
  const st = state as { plans?: unknown; activePlanId?: unknown };
  if (!Array.isArray(st.plans) || st.plans.length === 0) return unchanged();

  const totalRows = Array.isArray(todos) ? todos.length : 0;
  const tagged = topLevelTagged(todos);
  if (tagged.length === 0) return unchanged(false, 0, totalRows);

  const activeId = typeof st.activePlanId === "string" ? st.activePlanId : null;
  const planIdx = st.plans.findIndex(
    (p) => !!p && typeof p === "object" && (p as MutablePlan).id === activeId,
  );
  // No named active plan means no ordinal frame to join against. The client
  // picks one on hydrate; until then a tagged batch addresses nothing.
  if (planIdx < 0) return unchanged(false, tagged.length, totalRows);

  const plan = st.plans[planIdx] as MutablePlan;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return unchanged(false, tagged.length, totalRows);
  }
  const steps = plan.steps;

  const ordinals: number[] = [];
  for (const t of tagged) {
    for (let s = t.tag.lo; s <= t.tag.hi; s++) ordinals.push(s);
  }
  if (looksRebased(ordinals, steps.length)) {
    return unchanged(true, tagged.length, totalRows);
  }

  // Copy-on-write: never mutate the caller's parsed JSON in place.
  const nextSteps = steps.map((s) => (s && typeof s === "object" ? { ...(s as MutableStep) } : s));
  let changed = false;
  for (const t of tagged) {
    for (let s = t.tag.lo; s <= t.tag.hi; s++) {
      const idx = s - 1;
      if (idx < 0 || idx >= nextSteps.length) continue;
      const step = nextSteps[idx];
      if (!step || typeof step !== "object") continue;
      const target = step as MutableStep;
      if (target.status === t.status) continue;
      target.status = t.status;
      changed = true;
    }
  }
  const nextPlans = [...st.plans];
  nextPlans[planIdx] = { ...plan, steps: nextSteps };
  return {
    // `lastTodoAt` is the watermark a hydrating client compares its replayed
    // batch against (ADR-0116). Stamped with the turn's end, which is at or
    // after every event in it, so "the replay is newer" means the server has
    // genuinely not seen that batch.
    state: { ...(state as Record<string, unknown>), plans: nextPlans, lastTodoAt: at },
    joined: true,
    changed,
    taggedRows: tagged.length,
    totalRows,
    distrusted: false,
  };
}
