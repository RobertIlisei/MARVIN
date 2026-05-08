# Cost model

What it costs to run MARVIN and where that cost lands.

## Where cost comes from

MARVIN is a local tool. The only external service it calls is the Anthropic API. So the cost equation is:

```
  total cost = sum over all turns of (input tokens + output tokens + cache tokens) × model rate
```

No server cost, no storage cost, no analytics cost. Your machine runs everything else.

## Typical session costs

Empirical ballpark from real dog-fooding sessions on MARVIN's own codebase (Opus 4.7 solo, April 2026 pricing):

| Task type | Turns | Typical cost |
|---|---|---|
| Simple edit ("rename this variable") | 1-2 | $0.02-0.10 |
| Feature walk-through + diff ("add a branch badge") | 3-6 | $0.20-0.80 |
| Architecture-review pass ("review the theme cascade") | 5-10 | $0.50-2.00 |
| Long debugging session ("why is session resume dropping events") | 15-30 | $3-8 |
| Full feature with ADR + implementation + verification | 20-50 | $5-15 |

The range is wide because cost is dominated by:

1. **Context size at turn start.** Big project = big project context block = more input tokens.
2. **Whether MARVIN has to re-read vs use the graph.** Graphify-first queries are ~36× cheaper than file-read-heavy equivalents. See [Graphify integration](../concepts/graphify-integration.md).
3. **Tool-use iterations.** Deep refactors that loop through many Edit→verify→fix cycles accumulate faster than greenfield writes.
4. **Prompt-cache hits.** Consecutive turns in a session benefit from cache reads (cheaper per token). First turn of a session is the most expensive.

## The advisor strategy

Setting the header picker to Sonnet 4.6 executor + Opus 4.7 advisor typically saves **30-40%** on routine work with minimal quality loss per Anthropic's launch data (`advisor_20260301`). See [ADR-0003](../decisions/0003-advisor-strategy.md).

Savings break down roughly:

- Routine steps (reads, greps, mechanical edits): Sonnet is ~1/5 the cost of Opus.
- Hard steps (architecture decisions, complex refactors): executor calls the `advisor` tool, paying Opus rates just for that sub-call.
- Net effect: most tokens run at Sonnet rate, the decisive ones at Opus rate.

For cost-sensitive sessions, advisor mode is the single biggest lever. Default stays Opus solo ([ADR-0002](../decisions/0002-default-to-opus-4-7.md)) because quality matters more than cost on first-impressions.

## What you pay for vs what Anthropic bills

MARVIN's `cost-tracker.json` records the `costUsd` the Agent SDK returns per `turn.completed`. That number is what Anthropic's API billing response reports — authoritative for that call.

Caveats:

- **Failed turns** (`turn.error`) don't record a cost. Most failures are network-level or client-abort, so partial-cost undercount is small in practice.
- **Aborted turns** (`POST /api/chat/cancel`) record whatever the SDK managed to bill for work done before abort.
- Anthropic's actual billing lives on their side. MARVIN's ledger is a local estimate accurate at the per-turn level.

See [Cost tracking](../operations/cost-tracking.md) for the implementation.

## Cost inspection

**Live:**

- Header cost pill → today's spend, current session.
- Brain side panel → current session's running cost + token counts.

**Historical:**

- `GET /api/cost?projectId=…` → today / 7d / lifetime aggregation.
- Per-row detail: `cat ~/.marvin/cost-tracker.json | jq`.

**Anthropic side:**

- console.anthropic.com → your org's billing dashboard. Authoritative.

## Local machine cost

Near zero. MARVIN's sidecar is a Next.js production process (~200 MB RAM idle, low CPU), kept up by a launchd user agent. The macOS app holds the UI. Disk usage:

- JSONL session transcripts: ~0.5-5 MB per 20-turn session.
- Knowledge graph (per project): ~100 KB-few MB.
- Cost ledger: few KB per month of active use.

A year of active use on a single project rarely exceeds 100 MB of MARVIN-owned disk.

## Who pays

You. Your Anthropic account.

There is no MARVIN SaaS layer that bills on top. MARVIN is open-source infrastructure you install locally; it uses your API key / `claude auth login` to authenticate directly to Anthropic's API.

For teams: each developer runs their own MARVIN, each has their own credentials, each pays their own bill. No shared data, no multi-tenancy, no central billing. See [Licensing](./licensing.md).

## Cost controls

Practical levers, in descending order of impact:

1. **Switch to advisor mode** for routine work. 30-40% savings.
2. **Run `/graphify . --update` after code changes.** Keeps the graph fresh so MARVIN orients via graph header instead of re-reading files.
3. **Keep sessions focused.** A 2-hour session on one feature is cheaper per output than the same feature split across 6 short sessions (because cache hits matter and project-context rebuilds cost input tokens).
4. **Use `⌘⇧N` for new sessions** when genuinely moving to a new task. Prevents long sessions from accumulating irrelevant context that then has to be re-carried.
5. **Prune session transcripts** (`~/.marvin/sessions/`) on machines with disk pressure. Doesn't affect Anthropic-side cost.

## Related

- [Cost tracking operations](../operations/cost-tracking.md)
- [Advisor strategy](../concepts/advisor-strategy.md)
- [ADR-0002 — default to Opus 4.7](../decisions/0002-default-to-opus-4-7.md)
- [ADR-0003 — advisor strategy](../decisions/0003-advisor-strategy.md)
- [Anthropic pricing](https://www.anthropic.com/pricing)
