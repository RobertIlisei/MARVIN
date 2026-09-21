@AGENTS.md

## Claude-specific

`AGENTS.md` (imported above) is the canonical, tool-neutral instruction file —
Codex and other agents read it directly. Put shared rules there; this file holds
only what a Claude Code session uses.

- **graphify as a skill**: `/graphify query "…"`, `/graphify path "A" "B"`,
  `/graphify explain "Node"`, and `/graphify . --update` after code changes —
  the same operations as the `graphify` CLI commands in `AGENTS.md`.
- **Repo slash commands** (`.claude/commands/`): `/graph-refresh` rebuilds the
  code and knowledge graphs; `/rebuild-app` bundles and installs MARVIN.app.
- **Hooks and permissions**: `.claude/hooks/validate-bash.sh` runs before Bash
  (denies `--no-verify`, force-push to main, `reset --hard origin/*`, gpgsign
  bypass); shared permissions in `.claude/settings.json`, personal overrides in
  `.claude/settings.local.json` (gitignored).
