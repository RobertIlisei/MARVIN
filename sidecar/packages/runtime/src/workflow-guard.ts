/**
 * Workflow-completion guard (ADR-0057).
 *
 * Phase 7 of MARVIN's workflow (personality.ts) requires that when a real-work
 * turn closes — the `<!-- marvin:scope-met -->` sentinel — the plan's TodoWrite
 * items are reconciled and any ADR's `## Scope of Done` is marked. That's a
 * prose MUST, and prose MUSTs fire unreliably (the recurring lesson behind every
 * firm surface here). Observed: MARVIN declares a plan finished while its
 * TodoWrite items sit `pending`/`in_progress` and the ADR's `- [ ]` boxes are
 * never ticked.
 *
 * This is the mechanical backstop, the same shape as the check-back guard
 * (ADR-0055): at turn end, if the scope-met sentinel is present AND the work
 * isn't reconciled, the runtime fires a corrective follow-up turn that makes
 * MARVIN reconcile HONESTLY — mark what's genuinely done, and for anything not
 * done, say so and retract the claim (never tick a box just to clear the guard).
 *
 * Pure functions only — the caller (`sdk-runner`) owns the file reads and the
 * `scheduleWakeup` dispatch.
 */

/** The Phase-7 close sentinel — kept in lockstep with personality.ts and the
 *  Swift `ScopeMetDetector.sentinel`. */
export const SCOPE_MET_SENTINEL = "<!-- marvin:scope-met -->";

/** A stated scope-NOT-met handoff: a bold lead ("**Not done yet**", "**Scope
 *  not met:**") or the phrase anywhere ("scope is not met", "scope isn't met
 *  yet"). The one definition every sentinel reader shares. */
export const SCOPE_NOT_MET =
  /\*\*\s*(?:scope (?:is )?not(?: yet)? met|not scope met|not done(?: yet)?)\b|\bscope (?:is |has )?(?:not|n[o']t)(?: yet)? (?:been )?met\b|\bscope isn['’]t(?: yet)? met\b/i;

export function statesScopeNotMet(text: string): boolean {
  return SCOPE_NOT_MET.test(text);
}

/**
 * The sentinel counts only when the text doesn't say the opposite. 2026-09-29:
 * a tab ended two turns "Scope is not met … <sentinel>" — the practice rule's
 * prompt said a turn that edited files "must end with" the sentinel, and the
 * model obeyed it literally. Every reader (watch feed, auditor, reconcile
 * guard, the app's chip) goes through here, so a slip can't read as done.
 */
export function hasScopeMet(text: string): boolean {
  return text.includes(SCOPE_MET_SENTINEL) && !statesScopeNotMet(text);
}

interface TodoItem {
  content?: unknown;
  status?: unknown;
  activeForm?: unknown;
}

/**
 * Summaries of TodoWrite items that are NOT `completed` (i.e. `pending` /
 * `in_progress`). Empty when the payload is absent/malformed or all done. The
 * caller passes the LAST TodoWrite payload of the turn — authoritative under
 * ADR-0046's full-list-rewrite rule.
 */
export function openTodos(todos: unknown): string[] {
  if (!Array.isArray(todos)) return [];
  const out: string[] = [];
  for (const raw of todos) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as TodoItem;
    if (t.status === "completed") continue;
    const label =
      typeof t.content === "string" && t.content.trim()
        ? t.content.trim()
        : typeof t.activeForm === "string" && t.activeForm.trim()
          ? t.activeForm.trim()
          : "(untitled item)";
    out.push(label.slice(0, 120));
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * Open (non-`completed`) top-level step labels of the ACTIVE plan in a persisted
 * plan-state spine (`{ plans: [{ id, steps: [{ content, status }] }],
 * activePlanId }`, ADR-0052). The runtime reads this as a FALLBACK — only when
 * the completing turn emitted no `TodoWrite` of its own (so the plan didn't
 * advance this turn and the debounced-PUT state can't be racily stale). The
 * shape is the client's (server-opaque per ADR-0052), so this parse is fully
 * defensive: any deviation returns `[]` (no gap), never throws. Sub-tasks are
 * excluded — completion is step-level only, matching `Plan.isComplete`.
 */
export function openPlanSteps(planState: unknown): string[] {
  if (!planState || typeof planState !== "object") return [];
  const st = planState as { plans?: unknown; activePlanId?: unknown };
  if (!Array.isArray(st.plans)) return [];
  const plans = st.plans.filter(
    (p): p is { id?: unknown; steps?: unknown } => !!p && typeof p === "object",
  );
  const activeId = typeof st.activePlanId === "string" ? st.activePlanId : null;
  const active = activeId ? plans.filter((p) => p.id === activeId) : [];
  // If activePlanId names a real plan, check only it; otherwise check every plan.
  const scope = active.length > 0 ? active : plans;
  const out: string[] = [];
  for (const plan of scope) {
    if (!Array.isArray(plan.steps)) continue;
    for (const raw of plan.steps) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as { content?: unknown; activeForm?: unknown; status?: unknown };
      if (s.status === "completed") continue;
      const label =
        typeof s.content === "string" && s.content.trim()
          ? s.content.trim()
          : typeof s.activeForm === "string" && s.activeForm.trim()
            ? s.activeForm.trim()
            : "(untitled step)";
      out.push(label.slice(0, 120));
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/**
 * True when a markdown doc's `## Scope of Done` section is ENTIRELY unticked —
 * at least one `- [ ]` and ZERO `- [x]`. That's the "forgot to mark anything"
 * signal. A MIX (some `[x]`, some `[ ]`) is deliberately NOT flagged: a
 * partially-ticked DoD is usually correct — bullets get legitimately deferred
 * (an ADR may leave its "durable follow-up" box unchecked on purpose). We only
 * catch the wholesale miss, never second-guess a considered partial.
 */
export function scopeOfDoneEntirelyUnticked(md: string): boolean {
  const m = md.match(/^#{1,6}\s+Scope of Done\b[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/im);
  if (!m?.[1]) return false;
  const section = m[1];
  const unticked = (section.match(/^\s*[-*]\s*\[\s\]/gim) ?? []).length;
  const ticked = (section.match(/^\s*[-*]\s*\[[xX]\]/gim) ?? []).length;
  return unticked > 0 && ticked === 0;
}

/**
 * Merge the two independent statements about what is still open, de-duplicated
 * and order-preserving (ADR-0116).
 *
 * The persisted spine and the turn's own `TodoWrite` are not redundant: the
 * spine carries steps the executor may have forgotten it had, and the batch
 * carries tier-1 items that were never plan steps. Either saying "open" makes
 * it open. Taking the batch alone is what let a plan close at 8/14 while the
 * model reported 14/14 — the claim was checked against itself.
 */
export function mergeOpenItems(spineSteps: string[], batchTodos: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of [...spineSteps, ...batchTodos]) {
    const key = label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= 20) break;
  }
  return out;
}

export interface WorkflowGap {
  openTodos: string[];
  /** ADR basenames whose Scope of Done is entirely unticked. */
  untickedAdrs: string[];
  /**
   * ADR-0100 — advisor caveats still unresolved at the close.
   *
   * A caveat is a **condition on a `go` already given**, not deferred work, so
   * it belongs to the scope it was attached to and has to be answered before
   * that scope closes. This is the same shape as an unticked Scope-of-Done
   * box: the executor claimed done, and something it was told to satisfy has
   * no stated outcome.
   */
  openConditions?: string[];
  /**
   * ADR-0116 — the closing `TodoWrite` carried no usable `[N]` tag against an
   * active multi-step plan, so nothing it claimed could be joined to a step.
   *
   * Seen after an auto-compaction: the batch came back untagged and reworded
   * from the summary, every ordinal was gone, and a list that said "14 of 14
   * completed" could not close a single one. The executor needs telling WHY
   * its claim did not land, or it re-states the same untagged list.
   */
  untaggedClose?: boolean;
  /**
   * ADR-0121 — provisional backlog items this session parked that name
   * something this session's own changes touched: a file, an ADR it edited,
   * its branch. On 2026-09-28 three tabs each found the breakage their own
   * commit caused, described it precisely in a backlog item, and declared the
   * scope met — so the break shipped with the branch. A consequence of your
   * own change is part of the change; it is resolved before the close.
   */
  ownConsequences?: OwnConsequence[];
}

export interface OwnConsequence {
  id: string;
  title: string;
  /** The token that tied it to this session's changes. */
  because: string;
}

export interface ParkedItem {
  id: string;
  title: string;
  body: string;
}

/** Basenames so common that naming one says nothing about which file. */
const GENERIC_BASENAMES = new Set([
  "index.ts", "index.tsx", "index.js", "route.ts", "page.tsx", "layout.tsx", "types.ts", "utils.ts",
  "README.md", "package.json", "tsconfig.json", "pom.xml", "build.gradle", "Makefile", "INDEX.md",
  "CHANGELOG.md", "settings.json", "config.ts", "main.ts", "App.tsx", "app.ts",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The tokens that tie text to a set of changed files: each file's path, a
 * distinctive basename, a class-like stem, and an ADR number for an ADR file.
 * Pure; exported for tests.
 */
export function ownChangeTokens(files: string[], branch?: string): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const rel = f.replace(/^\.\//, "");
    const adr = /(?:^|\/)docs\/(?:adr|decisions)\/(\d{4})-/.exec(rel);
    if (adr?.[1]) {
      out.add(`ADR-${adr[1]}`);
      continue;
    }
    if (/(^|\/)\.marvin\//.test(rel)) continue;
    out.add(rel);
    const base = rel.split("/").pop() ?? rel;
    if (base.length >= 8 && !GENERIC_BASENAMES.has(base)) out.add(base);
    const stem = base.replace(/\.[^.]+$/, "");
    if (stem.length >= 10 && /[A-Z]/.test(stem)) out.add(stem);
  }
  if (branch && branch.length >= 12) out.add(branch);
  return [...out];
}

/**
 * ADR-0121 — which parked items are about this session's own changes.
 * Matching is literal with word boundaries (ADR numbers case-insensitive).
 * A false positive costs one honest sentence in the corrective turn; a miss
 * ships a known break, so the matcher leans towards flagging.
 */
export function ownChangeConsequences(items: ParkedItem[], files: string[], branch?: string): OwnConsequence[] {
  const tokens = ownChangeTokens(files, branch);
  if (tokens.length === 0) return [];
  const out: OwnConsequence[] = [];
  for (const item of items) {
    const text = `${item.title}\n${item.body}`;
    const hit = tokens.find((t) => {
      const flags = t.startsWith("ADR-") ? "i" : "";
      return new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(t)}($|[^A-Za-z0-9_])`, flags).test(text);
    });
    if (hit) out.push({ id: item.id, title: item.title.slice(0, 100), because: hit });
    if (out.length >= 12) break;
  }
  return out;
}

/** True when there's anything to reconcile. */
export function hasWorkflowGap(gap: WorkflowGap): boolean {
  return (
    gap.openTodos.length > 0 ||
    gap.untickedAdrs.length > 0 ||
    (gap.openConditions?.length ?? 0) > 0 ||
    (gap.ownConsequences?.length ?? 0) > 0
  );
}

/**
 * Build the `reason` + `prompt` for the corrective turn. The prompt is worded
 * to force HONEST reconciliation — explicitly forbidding box-ticking-to-satisfy,
 * which would be a worse failure than the unmarked box.
 */
export function buildReconcilePrompt(gap: WorkflowGap): { reason: string; prompt: string } {
  const lines: string[] = [];
  if (gap.openTodos.length > 0) {
    lines.push(
      `- Plan items still open (not completed): ${gap.openTodos.map((t) => `"${t}"`).join(", ")}`,
    );
  }
  if (gap.untickedAdrs.length > 0) {
    lines.push(
      `- ADR(s) whose \`## Scope of Done\` is entirely unmarked: ${gap.untickedAdrs.join(", ")}`,
    );
  }
  const conditions = gap.openConditions ?? [];
  if (conditions.length > 0) {
    lines.push(
      `- Advisor condition(s) with no stated outcome: ` +
        conditions.map((c) => `"${c}"`).join(", "),
    );
  }
  const own = gap.ownConsequences ?? [];
  if (own.length > 0) {
    lines.push(
      `- Backlog item(s) you parked about your OWN changes: ` +
        own.map((o) => `\`${o.id}\` (names ${o.because})`).join(", "),
    );
  }
  // The conditions half needs its own instruction: reconciling a checkbox is
  // "tick what is true", but reconciling a condition is "say which held, and
  // park the ones that did not". Folding it into the ADR/todo sentence would
  // have made it advisory-sounding, which is exactly what ADR-0100 is moving
  // away from.
  // ADR-0116 — when the batch was untagged, the open items above are not a
  // disagreement about the work, they are the join failing. Say which, or the
  // executor reads the list as "MARVIN thinks I did nothing" and argues.
  const untaggedInstruction = gap.untaggedClose
    ? `\n\nYour closing \`TodoWrite\` carried no \`[N]\` step tags, so none of ` +
      `it could be joined to the plan — the ordinal IS the join key (ADR-0049), ` +
      `and text alone does not close a step. Re-read the active plan file, ` +
      `re-emit the FULL list with each row prefixed by its \`[N]\` tag, and use ` +
      `the plan's own step wording. If a compaction lost the plan, read it back ` +
      `from \`.marvin/plans/\` before you re-state it.`
    : "";
  const conditionInstruction =
    conditions.length > 0
      ? `\n\nFor each advisor condition, state \`met\`, \`not met\`, or ` +
        `\`waived, because …\`. Then park ONLY the not-met and waived ones with ` +
        `\`backlog_add\`, quoting the condition and naming the advisor as its ` +
        `source. A condition you met needs no backlog item — parking it is the ` +
        `noise that buried the real ones (ADR-0095's own measurement: 12 parked, ` +
        `10 dismissed, 2 kept). Do NOT claim a condition met to clear this ` +
        `check; an honest "not met" is the useful answer.`
      : "";
  // ADR-0121 — the parked-consequence half. "Park what you notice" is right
  // for an old problem found in passing and wrong for a break you just made;
  // this is where the two are told apart, by the executor, honestly.
  const ownInstruction =
    own.length > 0
      ? `\n\nEach of those items names a file, ADR or branch your own changes ` +
        `touched. For each, decide honestly:\n` +
        `  (a) your change CAUSED it (a broken caller, a contract a consumer no ` +
        `longer matches, an incomplete change): fix it now, in this tab, whatever ` +
        `the write set said, then \`backlog_resolve … done\` with the commit and test;\n` +
        `  (b) it is PRE-EXISTING or independent of your change: \`backlog_resolve … keep\` ` +
        `with a one-line note saying why your change did not cause it;\n` +
        `  (c) you caused it but cannot fix it here: leave it provisional, say so ` +
        `plainly, and do NOT claim scope met — the user decides.\n` +
        `Do not call a break pre-existing to clear this check; a known break ` +
        `shipped as "done" is the failure this exists to stop.`
      : "";
  return {
    reason:
      own.length > 0
        ? "auto: own-change consequences parked at scope-met (ADR-0121)"
        : conditions.length > 0
        ? "auto: reconcile plan/ADR/advisor conditions before scope-met (ADR-0057, ADR-0100)"
        : "auto: reconcile plan/ADR before scope-met (ADR-0057)",
    prompt:
      `You closed the last turn with the scope-met marker, but the workflow ` +
      `isn't reconciled:\n${lines.join("\n")}\n\n` +
      `Reconcile HONESTLY now: in TodoWrite, mark \`completed\` ONLY what is ` +
      `genuinely done; tick the ADR \`## Scope of Done\` bullets that genuinely ` +
      `happened. For anything NOT actually done, leave it open, say so plainly, ` +
      `and do NOT claim scope met. Do NOT mark or tick anything merely to clear ` +
      `this check — a false "done" is a worse failure than an unmarked box.` +
      untaggedInstruction +
      conditionInstruction +
      ownInstruction,
  };
}
