# Local development setup

For contributors working on MARVIN itself, not users running MARVIN against their own projects.

## Prerequisites

Same as [end-user Quickstart](../getting-started/quickstart.md) plus:

- `git` 2.30+
- Write access to a working directory for `~/marvin/`
- Optional: GitHub CLI (`gh`) if you want to open PRs from the terminal

## Clone

```bash
git clone https://github.com/RobertIlisei/MARVIN.git ~/marvin
cd ~/marvin
```

## Install

```bash
pnpm install
```

Pulls every dependency for all 7 packages in the monorepo. First run can take 2-5 minutes. Subsequent `pnpm install` calls with an unchanged lockfile are a few seconds.

## Dev loop

```bash
pnpm dev
```

Turbo runs every package's `dev` script. For MARVIN this is effectively `next dev --port 3030 --turbopack`, Next.js 16's dev server.

Hot-reload works for:

- `apps/web/src/**` — Turbopack HMR, sub-second refresh.
- `apps/web/src/app/globals.css` — instant, CSS HMR.
- `packages/**/src/**` — hot-reload via pnpm workspace linking; may require a full refresh on server-side changes.

Things that require a full restart:

- `apps/web/package.json` changes (deps)
- `turbo.json`, `pnpm-workspace.yaml` changes
- Environment variable changes — `pnpm dev` reads env at boot only.

## Typecheck

```bash
pnpm -r typecheck
```

`-r` = recursive across all packages. Takes ~10-15s on a clean tree. MARVIN's CI (when we add it) will run this.

## Build (production)

```bash
pnpm -r build
```

Compiles every package + runs `next build` for `apps/web`. Validates that the production bundler is happy — Next.js 16's stricter build-time checks catch things dev mode skips.

## Clean

```bash
pnpm -r clean
```

Removes `.next/`, `.turbo/`, `dist/`, `*.tsbuildinfo`. Doesn't touch `node_modules/` — use `pnpm install --force` or `rm -rf node_modules && pnpm install` for that.

## The data dir while developing

MARVIN's data dir is `~/.marvin/` by default. **This is shared with any other MARVIN install you have.** While developing:

- Use a distinct `MARVIN_DATA_DIR` to keep dev sessions separate:

  ```bash
  MARVIN_DATA_DIR=~/.marvin-dev pnpm dev
  ```

- Or be comfortable with dev sessions mingling with whatever production sessions you also have.

## Testing against a throwaway project

Create a scratch directory:

```bash
mkdir -p ~/scratch/marvin-test && cd ~/scratch/marvin-test
git init
echo "# Test project" > README.md
git add . && git commit -m "initial"
```

Add it as a MARVIN project via the picker; pointed at `~/scratch/marvin-test` you can safely exercise edit/write/bash tools without touching real code.

## Working on skills

MARVIN reads skills from `~/.claude/skills/` (not from the repo's `.claude/skills/`). If you edit a skill:

1. Edit in the repo (`.claude/skills/<name>/SKILL.md`).
2. Re-run `bash scripts/install-skills.sh` to copy to `~/.claude/skills/`.
3. Restart any live MARVIN turns; skills are loaded on session init.

## Debugging the Agent SDK

Set `DEBUG` before `pnpm dev` to see the SDK's internals:

```bash
DEBUG=anthropic-sdk:* pnpm dev
```

Noisy. Useful when chasing tool-gate weirdness or confirm-flow timing.

## Related

- [Workspace layout](./workspace.md) — monorepo structure.
- [Testing](./testing.md)
- [Contributing](./contributing.md)
- [Env vars](../reference/env-vars.md)
