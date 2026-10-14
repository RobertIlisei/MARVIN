# ADR-0125 — Claude's server-side advisor runs alongside the advisor subagent, per tab and off by default

- **Status:** Accepted — partly implemented 2026-10-12 via [ADR-0126](./0126-a-model-for-every-helper-role.md) (app-wide `serverAdvisor` role instead of a per-tab toggle; ledger visibility and the measurement are still open)
- **Date:** 2026-10-12
- **Related:** [ADR-0003](./0003-advisor-strategy.md) / [ADR-0007](./0007-advisor-as-subagent-pattern.md) (the advisor strategy; why it became a subagent), [ADR-0033](./0033-advisor-registered-agent-per-role-effort.md) (registered advisor agent; its 2026-06-18 addendum left the server-side advisor unwired — this ADR revisits that), [ADR-0094](./0094-advisor-dispatch-uses-the-registered-agent.md) / [ADR-0095](./0095-advisor-verdict-is-read-and-caveats-persist.md) / [ADR-0100](./0100-advisor-caveats-are-conditions-not-backlog.md) (verdicts and caveats), [ADR-0108](./0108-per-session-posture.md) (per-session posture), [ADR-0118](./0118-one-prompt-per-session-and-settings-isolation.md) (settings isolation), Golden Rule 1 in `AGENTS.md`

## Context

MARVIN's advisor is a registered subagent (ADR-0033) that the executor dispatches on deterministic triggers. It works as a mechanism. Measured 2026-10-12 over the agri-saas-platform transcripts (1,253 sessions, `tool_use` blocks de-duplicated by id): **1,594 consults in 571 sessions**, 5 in the background, all but 11 on the registered agent's model. Verdict strings: ~73 % `go-with-caveats`, ~26 % `go`, ~2 % `stop` (string match over transcripts, so approximate).

A 2 % stop rate says the consult rarely changes direction. The structural reason is the input: **the advisor sees only the brief the executor writes.** The executor frames the question, chooses the evidence and omits what it didn't think mattered — the advisor reviews the executor's framing, not the work.

Claude Code's server-side advisor (`/advisor`, settings key `advisorModel`, Messages API tool `advisor_20260301`) has the opposite shape. Per https://code.claude.com/docs/en/advisor.md and https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool.md: the advisor **receives the full conversation, including every tool call and result**, has no tools, and the executor model decides when to call it (typically before committing to an approach, on recurring errors, before declaring done). It cannot be forced or capped from Claude Code.

ADR-0033's addendum (2026-06-18, SDK 0.2.113) left it unwired for two reasons: the flag was behind `CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL`, and a server-side allowlist rejected the then-default Opus. **Both are stale.** Live probe on 2026-10-12, SDK 0.3.286 (bundled Claude Code 2.1.286), `query({ options: { model: "claude-sonnet-5-5", settings: { advisorModel } } })`, no experimental env var:

| Advisor | Fired | Result block | Turn time | Advisor cost (16.7K-token context) | Turn total |
|---|---|---|---|---|---|
| `fable` → `claude-fable-5-1` | yes | `advisor_redacted_result` | 28.8 s | $0.228 (16,684 in / 1,230 out) | $0.301 |
| `opus` → `claude-opus-5-5` | yes | `advisor_redacted_result` | 17.1 s | $0.088 | — |

Two facts from the probe shape the decision:

1. **The advice is encrypted.** Both current advisors return `advisor_redacted_result`. MARVIN can show *that* the advisor was consulted and what it cost, never *what it said*. No verdict, no caveats, nothing for ADR-0095/0100 to parse.
2. **Cost scales with the transcript.** Each call re-reads the whole conversation with no cache reuse between calls. $0.23 at 16.7K tokens is roughly linear in context; an agri-saas tab at 150–200K tokens is an order of magnitude more per call.

There is also a latent leak. MARVIN loads `settingSources: ["user"]` (ADR-0118). The day the user runs `/advisor` in a Claude Code terminal, `advisorModel` lands in `~/.claude/settings.json` and silently reaches every MARVIN turn — the exact kind of uncontrolled inheritance ADR-0118 exists to stop. (Today `~/.claude/settings.json` has no `advisorModel`; verified.)

## Decision

**Run both advisors. They do different jobs.**

| | Advisor subagent (ADR-0033) | Server-side advisor (this ADR) |
|---|---|---|
| Sees | The executor's brief | The full transcript |
| Fires | Deterministic triggers, gate-enforced | Model-decided |
| Output | Parsed verdict + persisted caveats + reject-override deny | Encrypted guidance; consulted/declined + cost only |
| Role | **The enforced check on hard calls** | **Ambient: catches going in circles, wrong approach, premature "done"** |

The subagent stays the gate. Nothing in ADR-0094/0095/0100 changes, and the server-side advisor never satisfies an advisor trigger — the gate cannot read what it said.

Mechanics:

1. **Per-tab posture, off by default** (ADR-0108). A `serverAdvisor: "off" | <model alias>` posture field; the app-wide value is the default a new tab starts from.
2. **MARVIN owns the setting in both states.** On: pass `settings: { advisorModel }` in the `query()` flag layer. Off: set `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` in `turnEnv`, so a user-level `advisorModel` from Claude Code never reaches a MARVIN turn. Never inherited.
3. **A turn never breaks on it.** Claude Code applies its own pairing check and drops the advisor for an ineligible pair. If a turn still fails with an advisor error, MARVIN retries the turn once with the advisor disabled and reports it — the ADR-0033 addendum's condition.
4. **Visible.** `server_tool_use { name: "advisor" }` and its `advisor_tool_result` render in the subagent ledger as "Advising → Reviewed / Declined / Unavailable"; `usage.iterations[type="advisor_message"]` is attributed to the advisor model in `cost-tracker.json` and the status bar.
5. **Measured before it is recommended.** One week on agri-saas tabs, then decide default-on or not from: calls per session, advisor cost per session and as a share of the turn, and whether sessions with it show fewer reverted commits, fewer `stop` verdicts reached late, and fewer repeated-error loops (practice-loop extractors). The content cannot be compared with subagent caveats — it is encrypted.

**Golden Rule 1.** This is not a new subagent type and not model-dispatching-model on shared state: the server-side advisor has no tools, cannot touch the working tree, and its output returns to the one executor that asked. It is a second opinion inside one model call.

## Consequences

- The framing gap closes for the moments no trigger covers, at a cost that grows with the transcript — which is why it is opt-in and measured first.
- MARVIN cannot audit the advice. If a plaintext-result advisor becomes available for current models, revisit: the content could then feed ADR-0100's caveat flow.
- Subagents inherit the configured advisor (per the docs). Scouts and the advisor subagent itself will therefore also call it. Measure that cost separately in step 5; if it dominates, disable it inside subagent turns.
- The ADR-0033 addendum's "do not wire" is superseded for the server-side advisor; its "never break a turn" condition carries over as mechanic 3.
- Not available on Bedrock / Vertex / Foundry, and gated by a feature flag that telemetry-disabling env vars turn off. MARVIN surfaces "Advisor unavailable" rather than failing.

## Scope of Done

- [x] Live probe: server-side advisor fires from an SDK 0.3.286 `query()` via `settings.advisorModel` with Fable 5.1 and Opus 5.5; result type, latency and cost recorded above.
- [x] `serverAdvisor` wired into `sdk-runner.ts` — as an app-wide helper role (ADR-0126), not a per-tab posture field: `settings.advisorModel` when on, `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` when off; `role-models.test.ts` pins both.
- [x] A user-level `advisorModel` in `~/.claude/settings.json` cannot reach a MARVIN turn while the role is off: the tool is disabled by env (pinned by test).
- [ ] ~~An advisor-caused turn failure retries once without the advisor~~ — dropped for now: Claude Code drops an ineligible pairing itself; revisit if a failure is ever seen.
- [ ] Advisor calls appear in the subagent ledger and advisor tokens in cost tracking, attributed to the advisor model.
- [ ] One-week measurement on agri-saas tabs written up as an addendum here, with a default-on/off decision.
