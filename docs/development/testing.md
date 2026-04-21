# Testing

**Status as of 2026-04-21:** unit tests land for security-critical surfaces via Vitest (`pnpm test`). Everything else is still typecheck + manual probes — see the roadmap under "Not yet covered" below.

## What runs on `pnpm test`

```bash
pnpm test          # one-shot; 61 tests in ~160 ms today
pnpm test:watch    # interactive; reruns on change
```

Config: `vitest.config.ts` at the repo root. Node environment (no jsdom — the tested code is runtime / tools / sandbox). Tests live next to their package: `packages/<pkg>/tests/*.test.ts`.

**Coverage today** — the security surface that ADR-0008 / ADR-0009 hinge on:

| Module | File | Focus |
|---|---|---|
| `fs-sandbox` | `packages/runtime/tests/fs-sandbox.test.ts` | real tmp-dir fs — `..` escape, symlink rejection, ancestor-symlink realpath escape, NUL-byte, path-length cap, directory vs file, non-existent target + parent |
| `fs-write-policy` | `packages/tools/tests/fs-write-policy.test.ts` | auto / confirm / deny classification for every op kind — `.git` / `node_modules` denies, project-root delete guard, secret-file confirm (`.env*`, `id_rsa`, `*.pem`, etc.), case-only rename warn, permanent delete always confirm, size cap deny |
| `fs-constants` | `packages/tools/tests/fs-constants.test.ts` | ignore-list and secret-pattern membership — pinned so a casual removal shows up as a failing test |
| `fs-write-confirm-registry` | `packages/runtime/tests/fs-write-confirm-registry.test.ts` | token one-shot consumption, cwd + op-kind + path-list structural match, rename from/to swap rejected |

These tests are chosen because they're pure (no Agent SDK, no Next.js, no UI) and they cover the routes where a silent regression would re-open the write-channel attack surface.

## Not yet covered

The same three categories the original version of this doc flagged still apply to the *rest* of the codebase:

1. **Agent SDK interaction loop** (runtime + `/api/chat`). Needs integration tests that proxy SDK calls. Not built.
2. **Streaming UI** (chat message rendering, confirm cards, tree interactions). Needs a jsdom + playwright mix. Not built.
3. **Next.js API routes** individually. `scripts/smoke-file-writes.sh` is an end-to-end curl battery that proxies a fraction of this; structured tests would catch more.

Expansion is opportunistic: when a bug surfaces in untested code, add the test with the fix.

## What we have instead (for surfaces not yet covered)

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
