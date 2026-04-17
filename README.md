# MARVIN

**M**oderately **A**dvanced **R**obotic **V**irtual **I**ntelligence **N**etwork.

A pair-programming AI assistant. You drive vision and business decisions. MARVIN
drives architecture, infrastructure, code, tests, docs, and security.

You say *"let's build the login page"* — MARVIN dives in: reads the codebase,
proposes the schema + wiring + tests, executes with explicit confirms, commits.

> "Here I am, brain the size of a planet, and they ask me to build a login page."
> — MARVIN, probably

## Status

Active development. See [PLAN.md](./PLAN.md) for the full delivery plan.

## Stack

- Next.js 16 + TypeScript + Tailwind 4 + shadcn/ui
- pnpm workspaces + Turbo
- Claude CLI runtime (via `@marvin/runtime`)
- Graphify knowledge graph integration

## Quickstart

```bash
pnpm install
pnpm dev          # http://localhost:3030
```

## Repo layout

```
apps/web/                    # Next.js 16 app, port 3030
packages/
  runtime/                   # Claude CLI wrapper, auth, session, personality
  tools/                     # Bash, Edit, Write, Read, Grep, Glob, WebFetch, WebSearch
  project-context/           # BUSINESS_OVERVIEW injection + infra probes
  graphify-bridge/           # knowledge-graph read + refresh
  git-watch/                 # commit stream
  ui/                        # shadcn primitives + MARVIN chat bubble, diff, file tree
data/.marvin/                # session transcripts, cost tracker, graph cache (gitignored)
```

## Context

Formerly the JARVIS multi-agent orchestration project at `~/command_center/`.
The autonomous multi-agent pattern did not deliver reliably; MARVIN is the
pivot to a single pair-programming assistant.
