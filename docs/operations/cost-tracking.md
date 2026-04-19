# Cost tracking

MARVIN records spend on every completed turn and aggregates it per project.

## What gets recorded

Every `turn.completed` event includes `costUsd` and `tokenUsage` fields from the Agent SDK. [`cost-tracker.ts`](../../../packages/runtime/src/cost-tracker.ts) appends a row to `~/.marvin/cost-tracker.json`:

```json
{
  "at": "2026-04-18T07:31:24.589Z",
  "projectId": "users-you-code-marvin",
  "costUsd": 0.124451,
  "inputTokens": 6,
  "outputTokens": 212,
  "cacheCreationTokens": 19973,
  "cacheReadTokens": 17497
}
```

`inputTokens` + `outputTokens` are "fresh" tokens (new content). `cacheCreationTokens` + `cacheReadTokens` are prompt-cache hits — significantly cheaper per token, but still count toward cost.

No batching, no background writes — one row per turn, synchronously appended.

## Aggregation

`GET /api/cost?projectId=…` returns:

```ts
{
  today:    { costUsd, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, turns };
  week:     { /* same shape, last 7 days */ };
  lifetime: { /* same shape, everything */ };
  daily:    Array<{ day: string, costUsd: number, turns: number }>;  // last N active days
}
```

"Today" means the calling process's local midnight — whatever timezone the MARVIN server is running in. Not UTC.

## Surface in the UI

**Cost pill** (header, `<CostPill>`):

- Closed: shows today's spend.
- Open: drawer with today / 7d / lifetime, plus a 12-day sparkbar of per-day spend.
- Refreshes after every `turn.completed` via a `refreshKey` bumped in `page.tsx`.

**Brain side panel** (when the brain pane is showing):

- Shows the current session's running cost + token counts from `turn.completed.tokenUsage`.
- Updates live as turns stream.

Neither surface exposes per-row detail. For auditing, read `~/.marvin/cost-tracker.json` directly.

## How accurate is it

The `costUsd` comes from the Agent SDK. The SDK in turn gets it from Anthropic's API billing response, which reflects Anthropic's pricing tables at call time. Accurate to the cent for prompts that complete normally.

Caveats:

- **Failed turns** (`turn.error`) don't produce a `turn.completed`, so partial costs from failed calls aren't recorded. In practice this is a small fraction (most errors are client-side / network, not mid-completion).
- **Aborted turns** ( `POST /api/chat/cancel`) record whatever the SDK reports — usually partial cost for the work done up to the abort.
- **Advisor tool calls** are counted. When the executor calls `advisor`, that's a one-shot completion against the advisor model; its cost is part of the same turn's `costUsd`. You can't cleanly separate "Sonnet cost" vs "Opus cost" for a given advisor-mode turn without parsing the transcript.

## Comparing projects

Project IDs are stable — `slugifyWorkDir(workDir)` produces the same id from the same path across machines. So `cost-tracker.json` entries from multiple machines (if you rsync the data dir) will aggregate correctly by project id.

## Resetting

```bash
rm ~/.marvin/cost-tracker.json
```

MARVIN recreates an empty ledger on next turn. The registered projects, session transcripts, and everything else survive.

Note: deleting the ledger doesn't delete Anthropic's own billing records — they live on Anthropic's side. This is just MARVIN's local view.

## What's NOT recorded

- **Reads, grep, glob** costs — these are part of turns, which are recorded. But there's no per-tool-call breakdown.
- **Subagent task costs** — counted in the main turn's cost, not separately.
- **`/api/models` calls** — these are direct REST calls via the MARVIN server, not through the Agent SDK. They're not cost-tracked. In practice they're trivial (a few KB per call) and only fire when the user opens the model picker.

## Related

- [`cost-tracker.ts`](../../../packages/runtime/src/cost-tracker.ts)
- [HTTP API → Cost](../reference/api.md#cost)
- [Advisor strategy](../concepts/advisor-strategy.md) — the cost-optimization escape hatch.
- [Anthropic pricing](https://www.anthropic.com/pricing) — the authoritative rate card.
