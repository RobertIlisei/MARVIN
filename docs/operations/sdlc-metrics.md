# SDLC metrics

`scripts/sdlc-metrics.py` computes leading/lagging SDLC indicators for
MARVIN's own repo, read-only, from git + `gh` + the ADR corpus. No new
persistent state — nothing it reads or writes lives outside git and GitHub.

Prompted by Anthropic's [AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook),
which frames the loop as **leading indicators** (time from idea to committed
artifact, first-pass CI success, review cycle time) and **lagging
indicators** (defect escape rate, repeat incidents, rework per change, DORA
metrics) — human judgement stays above the loop; these numbers are what that
judgement should look at.

## Usage

```bash
python3 scripts/sdlc-metrics.py [--since YYYY-MM-DD] [--repo PATH]
```

Default window is the last 90 days. Requires `git`; `gh` (authenticated
against the repo's remote) is needed only for the CI success rate — every
other section still prints without it.

## What it computes, and why these proxies

MARVIN ships via commit → fast-forward push to main, not PR review (see
[Golden rule / ship flow](../roadmap.md)), so **review cycle time has no
signal here** and is deliberately not computed — the script says so in its
own output rather than printing a misleading zero.

| Metric | Class | Proxy used |
|---|---|---|
| Deployment frequency | DORA (lagging) | Release tags (`vX.Y.Z`) per week |
| Lead time for changes | DORA (lagging) | Hours from a commit's author date to the release tag that shipped it |
| Change failure rate | DORA (lagging) | % of ADRs later touched by a commit whose message contains "addendum" or "correction" — this repo's own rework signal (see [ADR-0068](../decisions/0068-plan-dedupe-provenance-and-negative-claims.md), which documents itself via addenda) |
| MTTR | DORA (lagging) | Days from an ADR's acceptance commit to its first addendum/correction commit |
| CI success rate | Leading | % of `push` runs of `test.yml` that succeeded, via `gh run list` |

**These are proxies, not DORA-canonical.** There's no staging/prod split and
no incident tracker, so "deployment" means "tagged release" and "change
failure" means "an ADR needed a correction" rather than "a deploy caused an
incident." Read trend direction across repeated runs, not the absolute
numbers against industry benchmarks.

## Example output

```
SDLC metrics for marvin — since 2026-06-01
(review cycle time not computed — this repo ships via FF push, not PR review)

DEPLOYMENT FREQUENCY   49 releases in window  (~3.9/week)
LEAD TIME FOR CHANGES  median 279.9h  (commit -> release tag, n=345)
CHANGE FAILURE RATE    9/73 ADRs (12.3%) needed an addendum/correction after acceptance
MTTR                   median 3.1 days  (ADR accepted -> first addendum/correction, n=9)
CI SUCCESS RATE        13/20 push runs (65.0%)
```

A 65% CI success rate or a change-failure rate climbing release over release
is the signal to act on — e.g. tighten pre-commit checks or split ADRs that
keep needing corrections. This script doesn't diagnose why; it tells you
where to look.

## Related

- [`scripts/sdlc-metrics.py`](../../scripts/sdlc-metrics.py)
- [`scripts/session-time-breakdown.py`](../../scripts/session-time-breakdown.py) — the sibling script for
  session-level wait-time analysis ([ADR-0067](../decisions/0067-gate-on-scope-not-turn-boundaries.md))
- [Anthropic's AI-native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook)
