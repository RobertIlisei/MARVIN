# Contributing

MARVIN is a small solo project at `github.com/RobertIlisei/MARVIN`. Contributions are welcome but not structured around a team process — the rules below are lightweight.

## Before you start

1. Read [CLAUDE.md](../../CLAUDE.md) (5 minutes). The Golden Rules are non-negotiable:
   - Single assistant, not agent team.
   - Plan-first, execute-second, verify-third.
   - No hardcoded project knowledge.
   - ADRs for material decisions.
2. Scan [PLAN.md](../../PLAN.md) for the current phase state + recent changelog entries.
3. Skim [docs/decisions/](../decisions/) to understand why things are the way they are.

## The 8-phase workflow applies to contributions too

See [The 8-phase workflow](../concepts/eight-phase-workflow.md). In practice for a PR:

- **Intake**: clear statement of what this PR does and why.
- **Discovery**: if the change touches graphify god nodes (see [graphify-out/GRAPH_REPORT.md](../../graphify-out/GRAPH_REPORT.md)), link the blast radius.
- **Plan**: multi-milestone PRs should explain the sequence in the description.
- **Implement + Verify**: typecheck clean, any new complexity motivated.
- **Ship**: conventional commit subject, `Co-Authored-By` tag if pair-programmed with MARVIN itself.

## Branch naming

```
feat/<short-kebab>       new feature
fix/<short-kebab>         bug fix
docs/<short-kebab>        docs only
polish/<short-kebab>      a11y / minor UX / style polish
refactor/<short-kebab>    internal restructure with no behavior change
```

## Commit messages

Conventional commits. Subject line stays under 72 chars. Body explains the *why* — the *what* is in the diff.

Example:

```
feat(polish): phase-5 a11y pass + active-project branch badge

UI polish:
- ShortcutsHelp: role="dialog" + aria-modal + aria-labelledby...
- ModelPicker: Esc closes dropdown...

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

When MARVIN pair-wrote the code, include the `Co-Authored-By` tag. It's how the repo's git history tracks the split.

## ADRs required when

Any of:

- New default behavior users will notice.
- A change to the tool policy's auto-allow, confirm, or hard-deny patterns (see [tool policy](../security/tool-policy.md)).
- A change to the runtime model defaults.
- A new `marvin-*` MCP server.
- A change that invalidates or supersedes an existing ADR.

Write it as `docs/decisions/NNNN-<kebab>.md` using the format in [ADR-0001](../decisions/0001-single-assistant.md). Increment the number past the highest existing.

## PR expectations

- **Description** explains the why. Link any related ADR.
- **Typecheck passes** (`pnpm -r typecheck`).
- **Build passes** (`pnpm -r build`).
- **If you touched graphify-visible code**, run `/graphify . --update` and commit the refreshed `graph.json` + `GRAPH_REPORT.md` with the PR.
- **If you touched PLAN.md phase entries**, ensure they're still coherent.
- **Screenshots** for visible UI changes (helps review; not mandatory).

## No-goes

Things that will block a PR:

- **Hardcoded specific-project knowledge** in MARVIN's own source. Service names, port numbers, realm ids, "we always use X framework." See [ADR-0005](../decisions/0005-per-project-isolation.md).
- **Multi-agent orchestration.** See [ADR-0001](../decisions/0001-single-assistant.md). If you want to propose replacing this, write a superseding ADR first; don't smuggle it in.
- **Breaking the confirm gate invariants.** The gate is structural — you can't add a "bypass" code path without it being an explicit ADR.
- **Uploading data anywhere other than Anthropic's API.** No analytics, no telemetry. See [Data flow](../security/data-flow.md).
- **Secrets in code.** `.gitignore` already blocks `.env*`; PRs containing hardcoded keys get the commit-remove-rotate-apology sequence.

## Reviewing

Solo project → solo reviewer (for now). When reviewing:

- **Does the PR have a reason?** Diffs without a stated motivation are usually refactor-for-refactor's-sake.
- **Does it cross ADR boundaries?** If yes, the new ADR should land in the same PR.
- **Typecheck clean?**
- **Does it need a test?** See [Testing](./testing.md). If the answer is "yes, but also, we have no test harness," note it in the PR but don't block.
- **Is there a simpler version?** MARVIN's [CLAUDE.md Golden Rule](../../CLAUDE.md) leans heavily on "don't add abstractions beyond what the task requires."

## Communication

- **Issues** for bugs + feature discussion: github.com/RobertIlisei/MARVIN/issues
- **PRs** for changes: github.com/RobertIlisei/MARVIN/pulls
- **No Slack, Discord, or chat channel** — deliberately low-overhead.

## License

Not yet specified (see [Licensing](../business/licensing.md)). Pending — contributions assume the same license MARVIN eventually ships under.
