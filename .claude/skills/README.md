# Vendored skills

Only the **MARVIN-adopted** skills are vendored here — ports of third-party
open-source skills that have **no upstream `anthropics/skills` source**, so the
repo is their only home:

| Skill | Source |
|---|---|
| `pr-review` | adapted from Garry Tan's gstack (`garrytan/gstack`) |
| `security-audit` | adapted from gstack |
| `systematic-debugging` | merges Jesse Vincent's Superpowers (`obra/superpowers`) + gstack |
| `test-driven-development` | ported from Superpowers |

Attribution lives at the bottom of each `SKILL.md`.

## Upstream Anthropic skills are NOT vendored

The upstream skills MARVIN also uses (`frontend-design`, `canvas-design`,
`theme-factory`, `brand-guidelines`, `doc-coauthoring`, `docx`, `pdf`, `pptx`,
`xlsx`, `claude-api`, `mcp-builder`, `webapp-testing`, `web-artifacts-builder`,
`skill-creator`, `internal-comms`) are **not committed** — they're ~10 MB and
belong to [anthropics/skills](https://github.com/anthropics/skills). They're
`.gitignore`d here and **fetched on demand** by `scripts/install-skills.sh`,
which shallow-clones `anthropics/skills` for any skill missing from this
directory. (Open-source tidy, 2026-06-15.)

If you want the upstream copies present locally — e.g. to pick them up while
running Claude Code *inside* the MARVIN repo, or for an offline install — drop
them into this directory; they'll be ignored by git but used by the install
script's fast path.

## Install into your user-level skills dir

```bash
bash scripts/install-skills.sh
```

Idempotent — existing skills in `~/.claude/skills/` are left alone; missing
upstream ones are cloned.

`graphify` ships from `~/.claude/skills/graphify/` separately (a local authored
skill, not from the Anthropic bundle). `honeycomb:*` ships via the
`honeycomb@honeycomb-plugins` Claude Code plugin — `/plugin install honeycomb`.
