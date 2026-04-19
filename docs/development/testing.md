# Testing

Honest status: **MARVIN has no automated tests of its own.** This doc explains why, what we have instead, and when that might change.

## Why there are no tests

MARVIN shipped v1 (Phases 1-4 + most of Phase 5 stretch) on 2026-04-17/18 without writing tests. Stated reasons:

1. **Pace.** The delivery plan explicitly prioritized a shipping shell over test coverage for v1. Every phase exit checklist mentions "typecheck clean" and sometimes "tests pass or added" — but in practice, "added" has been zero.
2. **Hard-to-unit-test surface.** Most of MARVIN's value lives in the Agent SDK interaction loop + the streaming UI. Good tests for that surface are integration tests that spin up a Next.js server, proxy SDK calls, and drive the browser. Expensive to build, easy to get wrong.
3. **Dog-fooding.** MARVIN is used on MARVIN. Every new feature is exercised by the developer immediately. Catches a different class of bugs than unit tests would, but catches a lot.

None of those reasons are durable. Tests will be needed before any serious team adoption.

## What we have instead

### Typecheck

```bash
pnpm -r typecheck
```

Strict TypeScript config (`strict: true`, `noUncheckedIndexedAccess: true`). This catches:

- Wrong prop types, missing nulls, undefined array access
- API response shape mismatches
- Function signature changes that break callers

What it doesn't catch: logic bugs. A function that always returns `0` when it should return `N` typechecks fine.

### Manual probes via `curl`

Most API endpoints are testable with a one-liner. PLAN.md's changelog has many entries ending with "verified via curl: …" as informal regression fixtures.

```bash
curl -s http://localhost:3030/api/health | jq .
curl -s 'http://localhost:3030/api/projects' | jq .
curl -N -X POST -H 'content-type: application/json' \
  -d '{"message":"hello","cwd":"/tmp","marvinSessionId":"test"}' \
  http://localhost:3030/api/chat
```

Works, doesn't scale.

### Visual verification via Playwright MCP

The `marvin-playwright` MCP server can drive a real browser against `localhost:3030`. Past PRs have used it for verifying UI changes land correctly:

> "Verified visually via `mcp__marvin-playwright` — MARVIN screenshot confirmed: staggered reveals, big italic wordmark, orbital rings, new status-bar style."

Ad-hoc, not a regression fixture.

### Dog-fooding

Every Phase 1-5 feature was exercised inside MARVIN's own session within hours of landing. The Hitchhiker's-Guide Deep Thought answer, basically — we use it on itself.

## What a reasonable test strategy would look like

When MARVIN adds tests, the order-of-valuable-coverage is roughly:

### 1. Pure-function unit tests

Highest ROI, lowest cost:

- **`packages/tools/policy.ts`** — classification of Bash commands into auto / confirm / deny. 50+ regex patterns; each needs a positive and negative case.
- **`packages/runtime/cost-tracker.ts`** — append + summarize logic.
- **`packages/runtime/projects.ts`** — `slugifyWorkDir()` + registry CRUD.
- **`packages/runtime/models.ts`** — `/v1/models` response parser + fallback selection.
- **`packages/graphify-bridge/read-graph.ts`** — BFS helpers against fixture graphs.

Tools: `vitest` or `bun test`. Pick based on whichever the pnpm workspace stays coherent with — probably vitest.

When writing new tests, reach for the [`test-driven-development`](../../.claude/skills/test-driven-development/SKILL.md) skill. It enforces RED-GREEN-REFACTOR with an Iron Law — no production code without a failing test first. Ported from Superpowers; adapted for MARVIN's single-assistant constraints.

For debugging a failing test or regression, the [`systematic-debugging`](../../.claude/skills/systematic-debugging/SKILL.md) skill runs the 4-phase root-cause workflow with a 3-strike rule (after 3 failed hypotheses, stop and question the architecture).

### 2. API-layer integration tests

Boot a Next.js test server, fire HTTP requests, assert responses.

- Health endpoint.
- Projects CRUD round-trips.
- Sessions list + hydrate.
- Confirm-gate resolution path.
- SSE event framing.

Tools: `next` built-in test mode + `supertest` or `undici`.

### 3. End-to-end UI

Playwright tests driving the real shell. Expensive to maintain, but:

- Theme toggle works across reloads.
- Confirm card renders Monaco diff for Edit.
- Session resume re-hydrates the transcript.
- Wordmark click returns to hero after a session.

Tools: `@playwright/test`. MARVIN already depends on `@playwright/mcp`, so the binary is present.

### 4. SDK-in-the-loop tests

The hardest category. Mocking the Agent SDK requires maintaining mock conformance with SDK evolution. Real SDK calls are expensive + flaky. A middle path:

- Record real SDK event streams to fixtures.
- Replay them into the runtime in tests.
- Assert the UI and persistence state at the end.

Defer until (1)-(3) are stable.

## When to add them

Triggers:

- **Contributor onboarding.** When a second person is regularly writing MARVIN code, tests move from "nice to have" to "required." Without them, changes break things invisibly.
- **Runtime rewrite.** If the Agent SDK ever evolves in a way that requires touching `sdk-runner.ts` substantially, adding tests around the existing behavior before the rewrite is cheap insurance.
- **Bug that should have been caught.** First time a regression ships that a unit test would have caught, the test backlog becomes visible. Close the gap in that specific area.
- **Refactor safety.** When refactoring `personality.ts` CORE_BEHAVIOR, a fixture-based test that asserts the rendered system prompt would make the change reviewable.

## What lint status is

None. Same reason as tests — Next 16 removed `next lint`, MARVIN deferred ESLint setup. Code hygiene maintained by:

- TypeScript strict mode
- Manual review (what little there is, given solo dev)
- Zero `console.log`s and exactly 1 `any` in the workspace (last audit: 2026-04-19, see the polish PR chain)

A Biome or ESLint setup is low-risk whenever anyone has the patience.

## Related

- PLAN.md — search for "verified via curl" for informal fixtures.
- [Workspace layout](./workspace.md) — where tests would live.
- [Contributing](./contributing.md)
