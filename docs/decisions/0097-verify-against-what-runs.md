# ADR-0097 — Verify against what runs: the bundled CLI, and the skills the loader registers

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0087](./0087-newest-claude-cli-and-reported-context-window.md) + [ADR-0093](./0093-spawn-the-cli-we-resolved.md) (both corrected here), [ADR-0082](./0082-claude-plan-usage-from-rate-limit-events.md) (the usage block, now actually unblocked), [ADR-0024](./0024-project-aware-skill-recommendations.md) (project-local skills), [ADR-0037](./0037-skill-enablement-active-set.md) (the active-skills block), [ADR-0079](./0079-subagent-tool-rename-and-rails.md) (the same lesson, first time)

## Context

Two unrelated-looking symptoms, one shared mistake.

**1. The plan-usage bars were still blank.** ADR-0087 found MARVIN reporting
one Claude CLI and running another, and fixed the reporting. ADR-0093 found
the spawn still wrong, and fixed `enrichedToolPath()` so the resolved
binary's directory leads `PATH`. The bars stayed blank after both.

`ps` on the running app settled it:

```
88076 …/MARVIN.app/…/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.2.113/…/claude
```

**The SDK does not resolve `claude` from `PATH`.** It spawns the native
binary its own package links to, so neither ADR touched the thing that
decides. In the bundle, that link pointed at **0.2.113** (CLI `2.1.113`)
while the SDK beside it was **0.3.251** (CLI `2.1.251`).

The cause is in `scripts/bundle-sidecar.sh`, which recreates the pnpm sibling
symlink Next's tracer drops:

```sh
NATIVE_PKG="$(… -name "@anthropic-ai+claude-agent-sdk-${TRIPLE}@*" … | head -n1)"
```

`head -n1` on `find` output is directory order. pnpm's store keeps every
version ever installed — 0.2.113, 0.3.245, 0.3.251 were all present — so the
bundle linked the oldest. `2.1.113` predates `unifiedWindows`, the field
carrying the percentages, so `recordClaudeRateLimit` received a headline event
with `resetsAt` and no `utilization` and the popover honestly rendered "no %
yet". This is the third instance of "first, not newest" in this repo:
ADR-0086 (release versions), ADR-0087 (CLI paths), now the native package.

**2. `Skill { hetzner-ssh }` → `Unknown skill`, 29 times.** Across every
MARVIN transcript ever recorded there are **29 `Skill` calls, all failures,
and not one success.** Each failure was followed by a `find` + `Read` hunt
for the file — the tokens the user noticed.

`listProjectSkills` named a skill `fm.name ?? name`: frontmatter name, else
the directory. `.marvin/skills/hetzner-ssh/SKILL.md` had **no frontmatter**,
so it was listed under its directory name, marked always-active
(ADR-0037: "project-local skills are always active"), and printed into the
active-skills prompt block as `- \`hetzner-ssh\` — (no description)` under
the heading *reach for them per their own triggers*. The model did exactly
that. The agent's skill loader, meanwhile, had skipped the file entirely.

MARVIN's listing and the loader's registry disagreed on three points, so the
loader was probed rather than assumed — five variants under one local plugin,
SDK 0.3.251:

| directory | frontmatter | registered as a skill |
|---|---|---|
| `good` | `name` + `description` | ✅ `probe:good` |
| `no-name` | `description` only | ✅ `probe:no-name` |
| `name-mismatch` | `name: totally-different` | ✅ `probe:name-mismatch` — the **directory** name |
| `no-fm` | none | ❌ |
| `no-desc` | `name` only | ❌ |

So: `description:` is the load-bearing key, `name:` is optional and a
disagreeing one is ignored, and the registered identity is always the
directory. And because project-local skills arrive through a plugin
(ADR-0024), the `Skill` tool only accepts them **namespaced** —
`marvin-project-local:adr-gate`. The prompt block had been printing bare
names for both trees, which is wrong for every project-local skill, whether
or not it loaded.

## Decision

**1. Link the native CLI by version, not by directory order.**
`bundle-sidecar.sh` derives the SDK's version from its own pnpm directory name
and links `@anthropic-ai+claude-agent-sdk-${TRIPLE}@${SDK_VERSION}`. A link
pointing anywhere else is replaced rather than left alone (the old `[ ! -e ]`
guard preserved a wrong link forever), and a missing version-matched native
package warns loudly instead of silently linking something else.

**2. MARVIN's skill listing reports what the loader will do.**
`listProjectSkills` names every skill after its **directory** and attaches a
`loadIssue` when the loader's answer differs from the pane's:

- no frontmatter → `blocked`
- frontmatter without `description:` → `blocked`
- `name:` disagreeing with the directory → advisory, naming the real
  invocation name

A `blocked` skill is dropped from the active set — including against an
explicit `skills.json` choice — so it can never be advertised as invocable
again. It is still *shown*, in the Skills pane with a red **NOT LOADED**
badge and the reason, and in the prompt block under a short "these are files,
not skills; read them directly" note, so the model reaches the content
without the hunt.

**3. The active-skills block prints invocation names.** User-global skills
stay bare; project-local skills are printed `marvin-project-local:<dir>`,
with an explicit line that the bare name is rejected.

Directories with no `SKILL.md` are silently ignored, not reported as broken —
`skill-creator` writes `<name>-workspace/` eval trees in there, and those are
working files.

## Consequences

- The plan-usage bars fill in. Verified: the bundle's linked binary reports
  `2.1.251 (Claude Code)`, and a live `rate_limit_event` from it carries
  `unifiedWindows: { five_hour: 0.28, seven_day: 0.54 }` — matching the
  Claude app exactly.
- `marvin-project-local:hetzner-ssh` registers (verified against the real
  project plugin after adding frontmatter). The 29-failure loop cannot recur
  silently: a skill in that shape now shows as NOT LOADED before it is called.
- **ADR-0087 and ADR-0093 are corrected, not superseded.** Both remain right
  about what they changed — the About panel should report the newest CLI, and
  the resolved binary's directory should lead `PATH` for the MCP subprocesses
  that *do* use it. Both were wrong that either governs the main turn's
  spawn. ADR-0093's `PATH[0]` test still passes and still proves nothing
  about which CLI runs.
- The standing lesson, third time of asking (ADR-0079, ADR-0093, here):
  **verify against the surface that decides.** `system/init` was not the tool
  namer, the About panel was not the spawner, and the Skills pane was not the
  skill registry. In all three the agreeing surface was checked and the
  deciding one was not.

## Scope of Done

- [x] Bundle links the native CLI matching the SDK's own version; a
      mismatched link is replaced; a missing one warns
- [x] Installed app repaired in place and confirmed at `2.1.251`
- [x] Loader behaviour probed, not assumed, and the table recorded above
- [x] `listProjectSkills` names by directory and reports `blocked` /
      advisory `loadIssue`
- [x] Blocked skills excluded from the active set, including against an
      explicit `skills.json` choice
- [x] Skills pane renders the reason; prompt block prints invocation names
      and lists non-loading files separately
- [x] 7 assertions covering both blocked shapes, the optional `name:`, the
      directory-wins rule, and workspace directories
- [ ] Not in scope: a runtime assertion that the *spawned* CLI's version
      matches the SDK's. That is the guard which would have caught this
      without a `ps`, and it belongs with `/api/health` — separate change.
