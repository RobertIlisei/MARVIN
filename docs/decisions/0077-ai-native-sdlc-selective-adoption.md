# 0077 — Selective adoption of the AI-native SDLC playbook

Status: Accepted · Date: 2026-08-29

## Context

Anthropic published [The AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook):
six stages (Plan / Design / Build / Test / Deploy / Maintain), a mandatory
artifact set (`intent.md`, `spec.md`, `plan.md`, `CLAUDE.md`, `REVIEW.md`), a
leading/lagging metrics framework, and a governance split between a
*deterministic* layer (permissions, sandboxing, hooks, managed settings) and an
*advisory* layer (skills, review findings, evals).

Its central claim — deterministic controls beat advisory prose — is the same
thesis as MARVIN's "firm surfaces" table, arrived at independently and for the
same reason. `scripts/sdlc-metrics.py` (2026-08-28) already implements the
metrics half. This ADR records the audit of everything else in the playbook:
what MARVIN adopts, what it already has, and what it deliberately refuses.

Three findings drove the accepted items:

1. **`personality.ts` had zero test coverage.** 98 test files in the repo; none
   touched the 1800-line file that defines every behavioural contract. Each
   firm surface in it exists because an audit measured a failure (2026-05-22
   skills firing ~0×; 2026-05-27 graph drift at ~7:1; ADR-0067's 33.1 h of
   stalls; ADR-0068's "fabricated" plan; ADR-0042's 419 KB memory). A future
   edit could delete any of them and nothing would fail.
2. **No guard existed at any layer against an agent weakening a test.** The
   playbook names this anti-pattern explicitly.
3. **`auto` permission strategy bypasses the `confirm` class outright**
   (`sdk-runner.ts` — "auto-mode bypass: <reason>"). So `confirm` is not a gate.
   For a local destructive command that is recoverable; for `gh release create`
   or `npm publish` it is not.

## Decision

**Adopt four items.**

1. **Firm-surface evals in CI** — `sidecar/packages/runtime/tests/personality-surfaces.test.ts`.
   Deterministic assertions that every firm surface, every `graph_*` MUST
   trigger, and every skill trigger is present and internally consistent; that
   the rule layer is byte-identical across all three personality modes (persona
   is style, not refusal); that every `ADR-NNNN` the prompt cites resolves to a
   file; and that every gate-sanctioned `subagent_type` is documented. Runs in
   the existing `pnpm test` job. Mutation-verified: deleting the `graph_affected`
   MUST heading fails the suite.

2. **Test-weakening guard** — `testWeakeningDenial` in `@marvin/tools/policy`,
   hard-deny on `Edit` / `Write` / `NotebookEdit`. Fires only on unambiguous
   weakening: a disable marker introduced (`.skip` / `.only` / `.todo` / `xit` /
   `@Disabled` / `pytest.mark.skip` / `t.Skip`), an assertion commented out, or
   an edit that removes *every* assertion from the region it touches. A partial
   assertion drop is allowed — consolidating three `expect`s into one
   `toMatchObject` is legitimate, and precision matters more than recall here.

3. **Publish/release guard** — `PUBLISH_HARD_DENY`, hard-deny on `gh release
   create|edit|upload|delete`, `npm`/`pnpm`/`yarn`/`bun`/`cargo` `publish`,
   `twine upload`, `docker push`, tag pushes, and `gh workflow run …release`.
   Not denied: `git tag` (a local tag publishes nothing) and branch pushes (the
   ship flow's normal path).

4. **Golden Rule 1 clarification** — a human steering N parallel sessions, each
   on its own worktree, is N single-assistant loops, not the flat-swarm shape
   the rule bans. Stated in `CLAUDE.md` and `personality.ts`.

**Reject the rest, with reasons.**

| Playbook item | Why not |
|---|---|
| `intent.md` (Stage 1) | Roadmap `## In flight` + Golden Rule 8's Definition of Done already carry problem, outcome and constraints. A sixth artifact class is the bloat ADR-0042 undid. |
| `spec.md` (Stage 2) | The ADR + `## Scope of Done` is strictly stronger: 9 deterministic triggers and a re-derivation test. |
| `plan.md` (Stage 3) | That is the plan spine (ADR-0046 / 0049 / 0052) plus `.marvin/plans/`. |
| PR gates / branch protection (Stage 5) | Contradicts the measured ship flow (commit → FF push to main) and ADR-0067's finding that human-speed gates cost 33.1 h of a 49 h session — the bottleneck the playbook itself names. |
| Monitoring bands → autonomous loop (Stage 6) | Mostly covered by the session auditor (ADR-0059), `auto-audit.jsonl`, the ADR-0031 wakeup rails and the ADR-0044 backlog sink. MARVIN is an IDE, not a monitored service. |
| Sandboxing (deterministic layer) | Rejected by the user, 2026-08-29. `fs-sandbox.ts` already covers path escape and symlink escape on the filesystem routes; process-level isolation is an architecture change with no demand behind it. |
| Managed settings | Single-user product; there is no admin to enforce against. |
| Western Electric detection rules | Statistical process control over a fleet. One user, one machine. |

## Consequences

- Editing `personality.ts` now requires keeping `personality-surfaces.test.ts`
  honest. When it fails, restore the surface or update the test **in the same
  commit as the ADR that sanctions the removal** — never delete the assertion
  to go green. The test file says this in its own header.
- MARVIN can no longer cut a release. That is intentional: the user's ship flow
  is human-run already, and publishing is the one class of action the
  permission model cannot take back. MARVIN states the exact command instead.
- MARVIN can no longer skip or gut a test to make a suite pass. It must fix the
  code, or say the test is wrong and let the user decide. TDD is unaffected —
  authoring tests only ever adds assertions.
- The prompt grew by one paragraph. The evals now bound that growth: an
  unreferenced surface fails the ADR-citation check.

## Alternatives considered

- **Behavioural evals** (does the model actually *obey* each trigger?) rather
  than structural ones. Strictly more valuable and strictly more expensive — it
  needs a harness, a fixture corpus and a per-run token budget. The structural
  suite is free, runs on every push, and catches the specific regression class
  observed to date (a surface silently deleted). Behavioural evals remain open;
  they need their own ADR and a budget decision.
- **Blanket deny on editing any test file.** Rejected: `test-driven-development`
  is a MUST-trigger skill and RED-GREEN-REFACTOR writes tests constantly. A
  guard that blocks legitimate work gets switched off, and then protects nothing.
- **Confirm rather than deny for publish.** Rejected: `auto` is the default
  strategy and bypasses `confirm`, so it would be a no-op in the mode that
  matters.

## Scope of Done

- [x] `personality-surfaces.test.ts` asserts every firm surface, `graph_*` MUST
      trigger, skill trigger, ADR citation and sanctioned subagent type; passes
      in CI; mutation-verified against a deleted MUST heading.
- [x] `toolPolicy` hard-denies the three test-weakening shapes and allows the
      four legitimate TDD shapes, both covered by tests.
- [x] `toolPolicy` hard-denies publish/release commands and allows the ship
      flow's own commands, both covered by tests.
- [x] Golden Rule 1 states the parallel-sessions carve-out in `CLAUDE.md` and
      `personality.ts`.
- [x] The rejected items are recorded here with reasons, so the next reader of
      the playbook does not re-litigate them.

## Related

- [ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md) — the read-only
  subagent invariant this ADR's Golden Rule 1 note bounds.
- [ADR-0042](./0042-memory-as-durable-facts.md) — the artifact-bloat failure
  that argues against `intent.md` / `spec.md` / `plan.md`.
- [ADR-0067](./0067-gate-on-scope-not-turn-boundaries.md) — the stall
  measurement that argues against stage-boundary approval gates.
- `scripts/sdlc-metrics.py` — the metrics half of the playbook, already shipped.
