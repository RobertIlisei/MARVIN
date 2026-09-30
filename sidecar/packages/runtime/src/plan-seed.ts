/**
 * The sidecar seeds, reads and ticks the plan spine itself (ADR-0124 D).
 *
 * Measured on the agri-saas-platform tabs of 2026-09-30: the Plan B tab
 * updated its task list ~5 times across 57 commits and many hours, Plan A ~3
 * times over ~10 commits. The spine (ADR-0046/0049/0052/0106/0116) read steps
 * open hours after they were done, the Sessions view could not show progress,
 * and the scope-met guard read a stale spine. Every earlier fix was prose in
 * the prompt, and prose MUSTs fire ~0×.
 *
 * So the spine no longer waits for the model to create it:
 *
 *   - **Seed.** A turn whose user message carries a checklist — a "Steps",
 *     "Definition of Done", "Done when", "Scope of Done" or "Acceptance
 *     criteria" heading followed by list items, or a numbered list — gets a
 *     `[1]…[N]` spine written before the model's first tool call. The model
 *     only has to tick it (and the gate, `checkPlanSpine`, sees that it does).
 *     A chore with no checklist gets nothing.
 *   - **Read.** `seededOpenSteps` is what the gate and the Stop hook ask.
 *   - **Auto-tick.** A background job that exits green, or a merge that
 *     lands, closes the ONE open step its kind names — tests, the fast band,
 *     Playwright, a merge. Zero or several candidates: nothing moves
 *     (ADR-0116: refuse to guess; an unticked box costs a turn, a false tick
 *     costs the user's trust in the plan).
 *
 * The parse mirrors `PlanParser` (Swift) where the two meet: a criteria block
 * is not a step when an explicit `## Steps` section exists, a leading checkbox
 * or bold ordinal is stripped, and only top-level items count.
 */

import { createHash } from "node:crypto";

import { readPlanState, writePlanState } from "./plan-state";
import { updateSessionMeta } from "./session-meta";

/** Headings whose list is the work itself. */
const STEPS_HEADING = /^(steps|implementation|plan|tasks|to ?do)\b/i;
/** Headings whose list is how the work is judged done. */
const CRITERIA_HEADING = /^(definition of done|done when|scope of done|acceptance criteria|dod)\b/i;

const MAX_STEPS = 30;
const MIN_STEPS = 2;

interface ListItem {
  indent: number;
  numbered: boolean;
  text: string;
}

const LIST_ITEM = /^(\s*)(?:[-*•+]|(\d+)[.)])\s+(.*)$/;

function parseItem(line: string): ListItem | null {
  const m = LIST_ITEM.exec(line.replace(/^(\s*)\*\*(\d+[.)])/, "$1$2"));
  if (!m) return null;
  const indent = (m[1] ?? "").replace(/\t/g, "  ").length;
  let text = (m[3] ?? "").trim();
  text = text.replace(/^\[[ xX-]\]\s*/, ""); // checkbox
  text = text.replace(/^\*\*(.+?)\*\*:?\s*/, "$1 ").trim(); // leading emphasis
  text = text.replace(/\*\*/g, "").trim();
  if (!text) return null;
  return { indent, numbered: m[2] !== undefined, text: text.length > 200 ? `${text.slice(0, 199)}…` : text };
}

/** A heading line's text: `## Steps`, `**Definition of Done**`, `Done when:`. */
function headingText(line: string): string | null {
  const t = line.trim();
  const md = /^#{1,6}\s+(.+?)\s*#*$/.exec(t);
  if (md) return (md[1] as string).replace(/[*_`]/g, "").replace(/:$/, "").trim();
  const bold = /^\*\*(.+?)\*\*:?$/.exec(t);
  if (bold) return (bold[1] as string).replace(/:$/, "").trim();
  const colon = /^([A-Za-z][A-Za-z ()/-]{1,40}):$/.exec(t);
  if (colon) return (colon[1] as string).trim();
  return null;
}

/** Top-level items of the list that starts right after line `start`. */
function listAfter(lines: string[], start: number): string[] {
  const items: string[] = [];
  let baseIndent: number | null = null;
  let blankRun = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim()) {
      blankRun++;
      if (items.length > 0 && blankRun > 1) break;
      continue;
    }
    if (headingText(line) && !parseItem(line)) break;
    const item = parseItem(line);
    if (!item) {
      if (items.length === 0) continue; // prose between the heading and the list
      if (/^\s{2,}\S/.test(line)) continue; // a wrapped continuation
      break;
    }
    blankRun = 0;
    if (baseIndent === null) baseIndent = item.indent;
    if (item.indent > baseIndent) continue; // nested: a sub-bullet, not a step
    if (item.indent < baseIndent) break;
    items.push(item.text);
    if (items.length >= MAX_STEPS) break;
  }
  return items;
}

/**
 * The checklist a message carries, as ordered step texts — or null for a chore.
 * Preference: an explicit steps section, then a criteria section, then the
 * first top-level numbered list of at least two items.
 */
export function parseChecklist(message: string): string[] | null {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  let steps: string[] | null = null;
  let criteria: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = headingText(lines[i] as string);
    if (!h) continue;
    if (!steps && STEPS_HEADING.test(h)) {
      const items = listAfter(lines, i + 1);
      if (items.length >= MIN_STEPS) steps = items;
    } else if (!criteria && CRITERIA_HEADING.test(h)) {
      const items = listAfter(lines, i + 1);
      if (items.length >= MIN_STEPS) criteria = items;
    }
  }
  if (steps) return steps;
  if (criteria) return criteria;
  // A bare numbered list: the first run of top-level `1.` / `2)` items.
  for (let i = 0; i < lines.length; i++) {
    const item = parseItem(lines[i] as string);
    if (!item?.numbered || item.indent > 3) continue;
    const run = listAfter(lines, i);
    const numberedOnly = run.length >= MIN_STEPS && lines.slice(i).filter((l) => parseItem(l)?.numbered).length >= MIN_STEPS;
    if (numberedOnly) return run;
    break;
  }
  return null;
}

/** `PlanTextMatch.normalize` (Swift): lowercase alphanumerics, single spaces. */
export function normalizeStepText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

interface SpineStep {
  id?: unknown;
  content?: unknown;
  status?: unknown;
  [k: string]: unknown;
}
interface SpinePlan {
  id?: unknown;
  steps?: unknown;
  seeded?: unknown;
  [k: string]: unknown;
}
interface SpineState {
  plans?: unknown;
  activePlanId?: unknown;
  lastTodoAt?: unknown;
  [k: string]: unknown;
}

function activePlan(state: unknown): { st: SpineState; plan: SpinePlan; idx: number } | null {
  if (!state || typeof state !== "object") return null;
  const st = state as SpineState;
  if (!Array.isArray(st.plans)) return null;
  const idx = st.plans.findIndex((p) => !!p && typeof p === "object" && (p as SpinePlan).id === st.activePlanId);
  if (idx < 0) return null;
  return { st, plan: st.plans[idx] as SpinePlan, idx };
}

function isOpen(status: unknown): boolean {
  return status !== "completed" && status !== "superseded";
}

/** Open steps of the ACTIVE plan when MARVIN seeded it, as `[N] text`. Empty otherwise. */
export function seededOpenSteps(state: unknown): string[] {
  const a = activePlan(state);
  if (!a || a.plan.seeded !== true || !Array.isArray(a.plan.steps)) return [];
  const out: string[] = [];
  (a.plan.steps as SpineStep[]).forEach((s, i) => {
    if (s && typeof s === "object" && isOpen(s.status)) out.push(`[${i + 1}] ${typeof s.content === "string" ? s.content : "(step)"}`);
  });
  return out;
}

/** True when the active plan is one MARVIN seeded. */
export function hasSeededPlan(state: unknown): boolean {
  return activePlan(state)?.plan.seeded === true;
}

export interface SeedResult {
  seeded: boolean;
  reason: string;
  steps?: string[];
  planId?: string;
}

/**
 * Write a `[1]…[N]` spine from `message` when it carries a checklist and the
 * session has no open plan already. Never replaces a plan with open steps —
 * a follow-up message inside a running plan is not a new plan.
 */
export function seedSpineFromMessage(
  projectId: string,
  sessionId: string,
  message: string,
  at: string = new Date().toISOString(),
): SeedResult {
  const steps = parseChecklist(message);
  if (!steps) return { seeded: false, reason: "no checklist" };
  const before = readPlanState(projectId, sessionId);
  if (!before.ok) return { seeded: false, reason: before.error };
  const state = (before.state && typeof before.state === "object" ? before.state : {}) as SpineState;
  const current = activePlan(state);
  if (current && Array.isArray(current.plan.steps) && (current.plan.steps as SpineStep[]).some((s) => s && isOpen(s.status))) {
    return { seeded: false, reason: "a plan with open steps is already active" };
  }
  const id = `brief-${createHash("sha1").update(steps.join("\n")).digest("hex").slice(0, 8)}`;
  const plans = Array.isArray(state.plans) ? [...(state.plans as SpinePlan[])] : [];
  if (plans.some((p) => p && p.id === id)) return { seeded: false, reason: "this checklist was already seeded", planId: id };
  const title = `Brief — ${steps.length} steps`;
  plans.push({
    id,
    title,
    text: `# ${title}\n\n## Steps\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`,
    path: null,
    steps: steps.map((s) => ({ id: normalizeStepText(s), content: s, status: "pending", subtasks: [] })),
    seeded: true,
    seededAt: at,
  });
  const next = { ...state, plans, activePlanId: id, lastTodoAt: at };
  const w = writePlanState(projectId, sessionId, next);
  if (!w.ok) return { seeded: false, reason: w.error };
  return { seeded: true, reason: "seeded", steps, planId: id };
}

/**
 * The turn runner's entry point: seed from the user's message before the SDK
 * query starts (so before the model's first tool call), record the checklist
 * on the session meta, log the outcome. A wakeup is never a brief. Never
 * throws.
 */
export function seedTurnSpine(args: { projectId: string; sessionId: string; message: string; turnId: string }): SeedResult {
  if (/^\[scheduled wakeup/.test(args.message)) return { seeded: false, reason: "wakeup" };
  try {
    const r = seedSpineFromMessage(args.projectId, args.sessionId, args.message);
    if (r.seeded && r.planId && r.steps) {
      updateSessionMeta(args.projectId, args.sessionId, {
        checklist: { planId: r.planId, steps: r.steps.length, seededAt: new Date().toISOString() },
      });
    }
    console.info(
      "[marvin.telemetry] " +
        JSON.stringify({ kind: "plan.spine.seed", turnId: args.turnId, seeded: r.seeded, reason: r.reason, steps: r.steps?.length ?? 0, at: new Date().toISOString() }),
    );
    return r;
  } catch {
    return { seeded: false, reason: "error" };
  }
}

/** The reminder a turn carries while a seeded plan has open steps — the
 *  ordinals are what makes the model's TodoWrite join (ADR-0049). */
export function seededSpineReminder(state: unknown, justSeeded: boolean): string | null {
  const a = activePlan(state);
  if (!a || a.plan.seeded !== true || !Array.isArray(a.plan.steps)) return null;
  const steps = a.plan.steps as SpineStep[];
  const open = steps.filter((s) => s && isOpen(s.status)).length;
  if (open === 0) return null;
  const list = steps
    .map((s, i) => `  [${i + 1}] ${s?.status === "completed" ? "✓ " : s?.status === "superseded" ? "– " : ""}${typeof s?.content === "string" ? s.content : ""}`)
    .join("\n");
  return (
    `## Plan spine (ADR-0124)\n${justSeeded ? "MARVIN seeded this tab's plan from your checklist" : "This tab's plan was seeded from its brief"} — ` +
    `${steps.length} steps, ${open} open:\n${list}\n` +
    "Keep it current with TodoWrite, one row per step prefixed with its `[N]` tag (sub-steps `[N.M]`). " +
    "A second `git commit` with no TodoWrite since the previous one is refused, and so is a scope-met close " +
    "while a step is still pending — mark it done, or superseded with the reason."
  );
}

// ── auto-tick ────────────────────────────────────────────────────────────

type TickKind = "playwright" | "fast-band" | "tests" | "merge";

const COMMAND_KINDS: Array<{ kind: TickKind; re: RegExp }> = [
  { kind: "playwright", re: /\bplaywright\b|\be2e\b/i },
  { kind: "fast-band", re: /fast[-_ ]?band|test:fast\b/i },
  {
    kind: "tests",
    re: /\b(vitest|jest|pytest|go test|cargo test|swift test|mvnw?\b[^|;&]*\b(test|verify)|gradlew?\b[^|;&]*\btest|(npm|pnpm|yarn|bun)\b[^|;&]*?\b(run )?test|make (test|check))\b/i,
  },
];

const STEP_KINDS: Record<TickKind, RegExp> = {
  playwright: /\bplaywright\b|\be2e\b|end-to-end/i,
  "fast-band": /fast[-_ ]?band/i,
  tests: /\btests?\b|\btest suite\b|\bgreen\b|\bvitest\b|\bjest\b|\bpytest\b/i,
  merge: /\bmerge[ds]?\b/i,
};

/** What a finished command proves, most specific kind first. */
export function commandTickKind(command: string): TickKind | null {
  for (const { kind, re } of COMMAND_KINDS) if (re.test(command)) return kind;
  return null;
}

export interface AutoTickResult {
  ticked: number | null;
  reason: string;
}

/**
 * Close the one open seeded step `kind` names. A step that names a MORE
 * specific kind (a Playwright step, when the event is a unit-test run) is not
 * a candidate. Zero or several candidates: refuse.
 */
export function autoTickSpine(
  projectId: string,
  sessionId: string,
  event: { kind: "job"; command: string } | { kind: "merge" },
  at: string = new Date().toISOString(),
): AutoTickResult {
  const kind: TickKind | null = event.kind === "merge" ? "merge" : commandTickKind(event.command);
  if (!kind) return { ticked: null, reason: "command proves no step kind" };
  const before = readPlanState(projectId, sessionId);
  if (!before.ok || !before.state) return { ticked: null, reason: "no spine" };
  const a = activePlan(before.state);
  if (!a || a.plan.seeded !== true || !Array.isArray(a.plan.steps)) return { ticked: null, reason: "no seeded plan" };
  const steps = a.plan.steps as SpineStep[];
  const moreSpecific = (text: string): boolean => {
    if (kind === "tests") return STEP_KINDS.playwright.test(text) || STEP_KINDS["fast-band"].test(text);
    return false;
  };
  const candidates: number[] = [];
  steps.forEach((s, i) => {
    const text = typeof s?.content === "string" ? s.content : "";
    if (s && isOpen(s.status) && STEP_KINDS[kind].test(text) && !moreSpecific(text)) candidates.push(i);
  });
  if (candidates.length !== 1) {
    return { ticked: null, reason: candidates.length === 0 ? `no open ${kind} step` : `${candidates.length} open ${kind} steps — ambiguous` };
  }
  const idx = candidates[0] as number;
  const nextSteps = steps.map((s, i) => (i === idx ? { ...s, status: "completed", autoTicked: { by: kind, at } } : s));
  const plans = [...(a.st.plans as SpinePlan[])];
  plans[a.idx] = { ...a.plan, steps: nextSteps };
  // `lastTodoAt` is deliberately NOT moved: it is the watermark of the last
  // TodoWrite the sidecar joined (ADR-0116), and an auto-tick is not one — the
  // model still owes the list an update, and staleness should still show.
  const w = writePlanState(projectId, sessionId, { ...a.st, plans });
  if (!w.ok) return { ticked: null, reason: w.error };
  return { ticked: idx + 1, reason: kind };
}

/**
 * A client PUT of the spine, merged with what only the server knows.
 *
 * The Swift model re-encodes a plan with the fields it declares, so a
 * debounced save would silently drop `seeded` — and with it the gate. It
 * also never saw a plan the sidecar seeded while the tab was off screen, so a
 * save could erase it. Both are carried: `seeded`/`seededAt`/`autoTicked`
 * onto the matching plan and step, and a seeded plan the client does not
 * carry is kept (and stays active when the client names none).
 */
export function mergeClientPlanState(existing: unknown, incoming: unknown): unknown {
  if (!incoming || typeof incoming !== "object") return incoming;
  if (!existing || typeof existing !== "object") return incoming;
  const ex = existing as SpineState;
  const inc = { ...(incoming as SpineState) };
  const exPlans = Array.isArray(ex.plans) ? (ex.plans as SpinePlan[]) : [];
  const seededEx = exPlans.filter((p) => p && p.seeded === true);
  if (seededEx.length === 0) return incoming;
  const incPlans = Array.isArray(inc.plans) ? [...(inc.plans as SpinePlan[])] : [];
  for (const sp of seededEx) {
    const i = incPlans.findIndex((p) => p && p.id === sp.id);
    if (i < 0) {
      // Missing from the save: keep it only if the client never saw it. A
      // client that hydrated after the seed echoes a watermark at or after
      // `seededAt`, and then a missing plan is one the user removed.
      const seenAt = typeof inc.lastTodoAt === "string" ? Date.parse(inc.lastTodoAt) : Number.NaN;
      const seededAt = typeof sp.seededAt === "string" ? Date.parse(sp.seededAt) : Number.NaN;
      if (!(Number.isFinite(seenAt) && Number.isFinite(seededAt) && seenAt >= seededAt)) incPlans.push(sp);
      continue;
    }
    const cp = incPlans[i] as SpinePlan;
    const exSteps = Array.isArray(sp.steps) ? (sp.steps as SpineStep[]) : [];
    const steps = Array.isArray(cp.steps)
      ? (cp.steps as SpineStep[]).map((s, j) => {
          const prev = exSteps[j];
          return prev && typeof prev === "object" && "autoTicked" in prev && s && typeof s === "object"
            ? { ...s, autoTicked: prev.autoTicked }
            : s;
        })
      : cp.steps;
    incPlans[i] = { ...cp, steps, seeded: true, ...(sp.seededAt ? { seededAt: sp.seededAt } : {}) };
  }
  inc.plans = incPlans;
  if (typeof inc.activePlanId !== "string" && typeof ex.activePlanId === "string") inc.activePlanId = ex.activePlanId;
  if (typeof inc.lastTodoAt !== "string" && typeof ex.lastTodoAt === "string") inc.lastTodoAt = ex.lastTodoAt;
  return inc;
}
