# MARVIN review rules

Read by the Claude Code managed code-review service and by any local
code-review plugin that honours `REVIEW.md`. Also used by the cherry-picked
`pr-review` skill under `.claude/skills/pr-review/`.

These rules narrow review scope to **MARVIN-specific structural concerns**.
For general project context see [CLAUDE.md](./CLAUDE.md).

## What Important means here

Reserve 🔴 Important for findings that:

- Violate a Golden Rule in [CLAUDE.md](./CLAUDE.md) — especially rules 1 (single
  assistant, no multi-agent), 4 (separate workspace), 5 (no truncation),
  6 (no hardcoded project knowledge), 7 (graphify first).
- Bypass the structural confirm gate in
  `packages/runtime/src/sdk-runner.ts` — adding a path that runs tools
  without `canUseTool`, weakening `toolPolicy()` classification, or
  introducing a hardcoded "bypass" flag.
- Touch credential-handling code (`packages/runtime/src/auth.ts`,
  `~/.claude/` readers) and leak tokens into logs, transcripts, or the
  cost ledger.
- Allow `.env*` / secret file reads without the explicit-intent signal
  the hard-deny policy expects.
- Send user content anywhere other than `api.anthropic.com` (see
  [docs/security/data-flow.md](./docs/security/data-flow.md)).
- Break the per-project isolation contract — MARVIN source referencing
  a specific user project's service names, paths, or framework.
- Change a public API shape in `apps/web/src/app/api/` without
  updating [docs/reference/api.md](./docs/reference/api.md).

## What Nit means here

Style, naming, formatting, minor refactor suggestions, missing
`aria-label`s, unused imports, dead code. TypeScript strict-mode
compliance is already checked via `pnpm -r typecheck`; don't
double-flag.

## Cap the nits

Report at most **five** 🟡 Nit findings per review. If there are more,
summarise as "plus N similar items" and post the rest only if they
recur on every push. Tiny style nits on a large PR drown the actually
important signal.

## Do not report

- **Anything `pnpm -r typecheck` already catches.** Type errors, missing
  properties, null deref. We rely on TypeScript strict mode
  (`noUncheckedIndexedAccess: true`) — duplicate coverage is noise.
- **Formatting.** No project-wide formatter runs yet. Don't flag
  whitespace, import order, or quote style.
- **Missing tests.** MARVIN currently has no automated test harness;
  see [docs/development/testing.md](./docs/development/testing.md).
  Suggesting "add a test" is expected to produce zero diff until the
  harness lands.
- **`graphify-out/*` regeneration.** The graph + report are checked-in
  artefacts. Flagging churn on `graph.json` / `GRAPH_REPORT.md` from a
  `/graphify . --update` run is noise.
- **`.claude/skills/` contents.** That's a pinned mirror of upstream
  Anthropic skills. Flagging their internal style is out of scope.
- **Monaco / xterm colour literals.** The theme-awareness is
  deliberate — `data-theme="dark"` switches registered themes. See
  [ADR-0006](./docs/decisions/0006-light-first-theme-cascade.md).
- **`// @ts-nocheck` on `brain-liquid.tsx`.** Documented at the top of
  that file; a ported physics engine under `noUncheckedIndexedAccess`
  would need ~100 `!` assertions.

## Always check

- **New API routes have an entry in** [`docs/reference/api.md`](./docs/reference/api.md).
  17 endpoints today; each lives in the reference with request/response
  shapes + SSE event table. A new route without a doc entry is a
  missed ADR-style obligation.
- **New MCP servers** (`marvin-*` alongside `marvin-graph` and
  `marvin-playwright`) have an entry in
  [`docs/reference/mcp-servers.md`](./docs/reference/mcp-servers.md)
  and an updated "prefer `marvin-*`" note in
  [`packages/runtime/src/personality.ts`](./packages/runtime/src/personality.ts).
- **Tool policy changes** (auto-allow regex additions, confirm/hard-deny
  list edits) have an ADR under `docs/decisions/`. Policy changes move
  silently otherwise and are a security boundary.
- **Ignore / deny / secret lists** (dir names, path segments, filename
  patterns for secrets) live exclusively in
  [`packages/tools/src/fs-constants.ts`](./packages/tools/src/fs-constants.ts).
  A new inline `IGNORE = new Set(...)` or re-declared deny pattern in a
  route or component is a drift bug waiting to happen — both write
  channels (LLM + user-initiated) must share the same source. See
  [ADR-0008](./docs/decisions/0008-user-initiated-write-channel.md).
- **New `/api/files/write/*` routes** must pair `checkFsPath` with
  `fsWritePolicy` and must honour `X-Marvin-Confirmed` for the
  `confirm` policy class. Any route that writes without the sandbox,
  or classifies without the policy, or skips the token check on
  `confirm`, is a 🔴 Important finding. See
  [ADR-0008](./docs/decisions/0008-user-initiated-write-channel.md).
- **Any new `multipart/form-data` route** must require the
  `X-Marvin-Client: 1` header to force a CORS preflight — multipart
  is a "simple" CORS request otherwise and cross-origin drive-by
  POSTs would reach the handler. A new multipart route without this
  guard is a 🔴 Important finding. See
  [ADR-0009](./docs/decisions/0009-file-uploads-from-os.md).
- **Hardcoded model identifiers** (`claude-opus-4-7` in UI strings or
  headers). Must read from `executorModel` / `advisorModel` state, not
  inline literals. The `<BranchBadge>`-era stale "model: claude-opus-4-7"
  in the brain panel was exactly this bug.
- **Log lines emitted by `apps/web/src/app/api/` routes** don't include
  full request bodies, user messages, API keys, or tokens. Session
  transcripts go to `~/.marvin/sessions/*.jsonl` by design; random
  `console.log` is not that channel.
- **Grep-and-pray file sweeps** (MARVIN reading many files to answer a
  structural question). These are a Golden Rule 7 violation — graph
  should have been queried first. Flag the pattern, not individual
  file reads.

## Verification bar

Behaviour claims in findings need a `file:line` citation from the diff
or surrounding code. "This seems to..." without a citation doesn't
ship. False positives cost the author a round trip.

## Re-review convergence

After the first review, suppress new 🟡 Nits and post only 🔴 Important
findings. One-line fixes shouldn't reach round seven on style.

## Summary shape

Open the review body with a one-line tally, e.g. `2 important, 1 nit, 0
pre-existing`. Lead with "No blocking issues" when 🔴 count is zero.

## Related

- [CLAUDE.md](./CLAUDE.md) — full project-level rules (read by reviewers).
- [docs/decisions/](./docs/decisions/) — ADRs the review should respect.
- [docs/security/tool-policy.md](./docs/security/tool-policy.md) — the
  auto/confirm/deny matrix.
- [docs/reference/api.md](./docs/reference/api.md) — authoritative
  endpoint catalogue.
