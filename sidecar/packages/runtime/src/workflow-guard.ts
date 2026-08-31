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

export function hasScopeMet(text: string): boolean {
  return text.includes(SCOPE_MET_SENTINEL);
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
}

/** True when there's anything to reconcile. */
export function hasWorkflowGap(gap: WorkflowGap): boolean {
  return (
    gap.openTodos.length > 0 ||
    gap.untickedAdrs.length > 0 ||
    (gap.openConditions?.length ?? 0) > 0
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
  // The conditions half needs its own instruction: reconciling a checkbox is
  // "tick what is true", but reconciling a condition is "say which held, and
  // park the ones that did not". Folding it into the ADR/todo sentence would
  // have made it advisory-sounding, which is exactly what ADR-0100 is moving
  // away from.
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
  return {
    reason:
      conditions.length > 0
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
      conditionInstruction,
  };
}
