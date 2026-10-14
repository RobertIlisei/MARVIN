# ADR-0033 — Advisor as a registered agent with its own reasoning effort

**Status:** Accepted — 2026-06-07
**Extends:** [ADR-0007](./0007-advisor-as-subagent-pattern.md) (advisor-as-subagent),
[ADR-0014](./0014-scout-subagents-read-only.md) (registered-agent precedent),
[ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md) (subagent mutation gate)
**Touches:** `sdk-runner.ts`, `tools/policy.ts`, `personality.ts`, chat route,
turn-orchestrator, wakeup records, native effort picker (`ChatAgentsFooter.swift`)

> **Addendum 2026-06-18 — corrects Context point 2, and explains why the
> server-side advisor stays unwired.** A later audit clarified the mechanics and
> tested them live against the 0.2.113 binary:
>
> - `advisorModel` is NOT a `query()` option — it's a field in the SDK's
>   *settings* schema (`sdk.d.ts:4575`), so `sdk.mjs` was never going to forward
>   it as a flag. The old `options.advisorModel` was therefore inert; it is now
>   removed (it did nothing — the advisor *subagent* model flows through the
>   `agents` map, which works).
> - The binary DOES have a real *server-side* advisor — `--advisor <model>`
>   (feature `advisor-tool-2026-03-01`), a cheap executor auto-escalating to a
>   stronger advisor on hard steps — reachable from `query()` via the
>   **`extraArgs`** escape hatch.
> - **But it is not usable as-is.** Live verification: the `--advisor` flag is
>   EXPERIMENTAL (an "unknown option" unless `CLAUDE_CODE_ENABLE_EXPERIMENTAL_
>   ADVISOR_TOOL=1`), AND the advisor model is allowlisted server-side. The
>   current default Opus (`claude-opus-4-8`) is REJECTED ("cannot be used as an
>   advisor"); only specific older ids pass (`opus-4-1`, `opus-4-6`,
>   `sonnet-4-6`), while `opus-4-5`/`haiku-4-5`/`opus-4-8` fail. Wiring it
>   naively with the default model would error the whole turn.
>
> Decision: **do not wire the server-side advisor** (experimental flag + a
> drifting, un-owned model allowlist = exactly the fragile dependency we avoid).
> Runtime "advisor" mode keeps the `agents`-map advisor *subagent* (a distinct,
> Task-dispatched mechanism that works). If revisited, it must be gated: enable
> the experimental env var AND pass `--advisor` only for an eligibility-checked
> advisor id, falling back to no-flag otherwise so a turn never breaks.
>
> **Superseded for the server-side advisor by [ADR-0125](./0125-server-side-advisor-alongside-the-advisor-subagent.md) (2026-10-12):** the experimental flag and the allowlist no longer block it on SDK 0.3.286; it is wired per tab, off by default, with the never-break-a-turn condition kept.

## Context

The user can set reasoning effort for the executor (`thinkingMode` →
SDK `effort`), but the advisor had no effort control — it implicitly ran at
whatever the model default was. The ask: **set effort individually for both
executor and advisor.**

Two SDK facts shape the design (verified against installed SDK 0.2.113):

1. **The Task tool input has no effort field.** The ADR-0007 advisor spawn
   (`subagent_type: "general-purpose"` + `model: "opus"` hint) cannot carry
   an effort. The ONLY mechanical lever for per-subagent effort is
   `AgentDefinition.effort` on an `agents:`-map registration.
2. **`Options.advisorModel` is dead code in the SDK runtime.** It is typed
   in `sdk.d.ts` but `sdk.mjs` never forwards it to the CLI (zero
   occurrences; no `--advisor-model` flag). MARVIN's advisor-model setting
   only ever worked because personality passed `model: "opus"` on the Task
   call. `AgentDefinition.model` accepts a full model id and works.

## Decision

Register an **`advisor` agent definition** per turn (like the scout,
ADR-0014), carrying:

- `model`: the user's advisor model (full id; `"inherit"` when unset), and
- `effort`: `resolveEffort(advisorThinkingMode ?? thinkingMode, advisorModel)`
  — a NEW `advisorThinkingMode` setting, same low→max ladder, defaulting to
  the executor's effort so omitting it preserves pre-0033 behaviour.

Advisor consults now spawn via `subagent_type: "advisor"`; the registered
definition supplies the blunt-critique prompt structure, the model, and the
effort. `"advisor"` joins `SANCTIONED_SUBAGENT_TYPES` (auto-allow);
`general-purpose` stays sanctioned for back-compat with the ADR-0007 shape.

The advisor is **read-only** like the scout: `disallowedTools:
[Edit, Write, Bash, NotebookEdit, WebFetch]` at the SDK layer, plus the
ADR-0030 agentID mutation gate as the structural backstop. This is not a
new capability grant — the advisor critiques; it never edits.

Plumbing: `advisorThinkingMode` flows native picker (`adv` chip, "follow"
default) → `POST /api/chat` body → `RunAgentInput` → agent definition; it
is recorded on `turn.started` and preserved across wakeup records
(ADR-0031) so a fired turn keeps the advisor posture. The unwired
`Options.advisorModel` is still passed for forward-compat with SDK versions
that wire it.

### Rejected alternative

Patching effort into the Task-call prompt ("think hard") — prompt-level
effort is not effort; it does not move the SDK's reasoning budget. Same
"mechanical, not prompt-based" principle as ADR-0030/0032.

## Consequences

- Advisor consults can run cheaper (e.g. executor `max`, advisor `medium`)
  or deeper (executor `low`, advisor `max`) than the executor —
  per-consult cost control the split-model design always implied.
- The advisor model setting now actually reaches the model serving the
  consult (it previously rode only on the prompt hint).
- Old transcripts/persisted wakeups without `advisorThinkingMode` parse
  fine (optional field, falls back to executor effort).

## Scope of Done

- [ ] `advisorThinkingMode` flows UI → body → runner → registered advisor
      agent with `model` + resolved `effort`.
- [ ] Advisor spawns as `subagent_type: "advisor"`; policy sanctions it;
      read-only toolset enforced.
- [ ] Omitted setting ⇒ advisor effort = executor effort (no behaviour
      change for existing users).
- [ ] `turn.started` + wakeup records carry the advisor effort.
- [ ] Unit tests (policy + advisor agent factory) pass; typecheck clean;
      Swift builds.
