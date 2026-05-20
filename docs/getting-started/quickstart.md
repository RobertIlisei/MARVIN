# Quickstart

From a fresh install to a running MARVIN with a working chat turn. Should take under 5 minutes.

## Recommended path — Homebrew cask

For end users, the canonical install is the Homebrew cask. The cask drops
`MARVIN.app` into `/Applications/` with Node 22.11.0, the Next standalone
tree, and every dependency bundled inside `MARVIN.app/Contents/Resources/`.

```bash
brew tap RobertIlisei/marvin
brew install --cask marvin-ai
```

The cask token is **`marvin-ai`** (not `marvin`, which would collide with
the unrelated "Amazing Marvin" cask on the homebrew-cask main tap).

Set `ANTHROPIC_API_KEY` in your shell (or run `claude auth login`),
launch MARVIN from the Dock, pick a project directory, and you're done.
See [Credentials](../security/credentials.md) for the full detection
order.

Skip to step 6 below if you took the brew path.

## Developer install — clone + pnpm

The rest of this page is the from-source path for contributors building
MARVIN itself.

## 1. Prerequisites

| Tool | Version | Install hint |
|---|---|---|
| Node.js | ≥ 22 | `brew install node@22` / `nvm install 22` |
| pnpm | 10.33+ | `npm install -g pnpm@10.33.0` (or use the `packageManager` field via Corepack) |
| Xcode | 16+ (or Command Line Tools only) | App Store, or `xcode-select --install` |
| Anthropic credentials | any one: `ANTHROPIC_API_KEY` env var **OR** `claude auth login` previously run | see [Credentials](../security/credentials.md) |
| Chromium (optional) | latest | `npx playwright install chromium` — only if you want MARVIN to drive a browser |

## 2. Clone + install

```bash
git clone https://github.com/RobertIlisei/MARVIN.git ~/marvin
cd ~/marvin
pnpm install
```

The install pulls the Claude Agent SDK, Next.js 16, xterm.js, monaco-editor, and the shadcn UI primitives.

## 3. Install the skills bundle (one-time)

MARVIN's SDK sessions inherit skills from `~/.claude/skills/`. A pinned mirror of the Anthropic skill set ships at `.claude/skills/` in the repo; this script copies it into place (idempotent — existing user-level skills are left alone):

```bash
bash scripts/install-skills.sh
```

Skills installed: `frontend-design`, `canvas-design`, `theme-factory`, `brand-guidelines`, `doc-coauthoring`, `docx`, `pdf`, `pptx`, `xlsx`, `claude-api`, `mcp-builder`, `webapp-testing`, `web-artifacts-builder`, `skill-creator`, `internal-comms`. The [graphify skill](https://github.com/safishamsi/graphify) is installed separately.

## 4. Start the dev server

```bash
pnpm dev
```

Next.js 16 + Turbopack on port **3030**. First boot typically takes 5-15 seconds. Stay in the terminal — `pnpm dev` is persistent.

## 5. Verify the runtime

```bash
curl -s http://localhost:3030/api/health
```

You should see:

```json
{
  "ok": true,
  "auth": { "mode": "host-credentials", "credentialHint": "~/.claude (CLI-managed · auto-detected)" },
  "claudeBinary": "/opt/homebrew/bin/claude",
  "binaryError": null,
  "defaultModel": "claude-opus-4-7",
  "dataDir": "/Users/you/.marvin"
}
```

If `auth.mode` is `"none"`: set `ANTHROPIC_API_KEY` or run `claude auth login` and reload. See [Credentials](../security/credentials.md) for the full detection order.

## 6. Add a project

Open `http://localhost:3030` in a browser.

1. Click the **project picker** in the header (or press `⌘K`).
2. Click **Add project**.
3. Enter a display name and an **absolute path** to a directory you want MARVIN to work in. It must exist and be a directory.
4. Click **Verify** → **Add**.

The project is registered at `~/.marvin/projects.json`. Switching projects changes `cwd` for every subsequent chat turn.

## 7. First turn

Type a message into the composer. Press ⏎ (or ⌘⏎). MARVIN will:

1. Inject the [project context](../concepts/isolation-contract.md) on the first message — your repo's own `README.md`, any `docs/adr/*.md`, `.marvin/memory.md` if it exists, plus a compact graph header if graphify has been run.
2. Stream a turn over SSE. The brain pane animates through `thinking` → `tool` → `writing` states.
3. Any Edit/Write/non-read Bash call will either auto-execute (default, matches `claude --dangerously-skip-permissions`) or show a confirm card with a diff preview, depending on the **perms** toggle. See [Confirm gate](../concepts/confirm-gate.md).
4. Cost + tokens tick up in the header pill. Per-turn cost is persisted to `~/.marvin/cost-tracker.json`.

## 8. What to try next

- **Run the knowledge graph on your project** — from inside the project's own directory: `/graphify .` (installs graphify if needed, then builds `<workDir>/graphify-out/graph.json`). Next MARVIN session will inject a graph header on the first message.
- **Flip the theme** with `☀`/`☾` in the header. See [ADR-0006](../decisions/0006-light-first-theme-cascade.md) for the cascade.
- **Try advisor mode** — click the `models` pill in the header, pick Sonnet 4.6 as executor + Opus 4.7 as advisor. Saves ~30-40% on routine code work. See [Advisor strategy](../concepts/advisor-strategy.md).
- **Open the graph pane** with `⌘G` — the live graphify data for the active project.
- **Keyboard shortcuts** — press `?` to see the full list.

## Things that might go wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `/api/health` returns `auth.mode: "none"` | No credentials detected | Set `ANTHROPIC_API_KEY` or run `claude auth login` |
| Models dropdown shows "fallback list" | `claude auth login` stored the token in macOS Keychain, which Node can't read | Set `ANTHROPIC_API_KEY` directly for live model listing |
| `port 3030 already in use` | Another MARVIN instance running | `lsof -iTCP:3030 -sTCP:LISTEN` → kill or use it |
| Blank page, console errors about hydration | Rare. Usually fixed by `pnpm dev` restart | If persistent, see [Troubleshooting](../guides/troubleshooting.md) |
| Browser-preview pane shows blank | Target page sends `X-Frame-Options: DENY` | Use the ↗ button to open in a new tab |
| Browser automation fails (`npx playwright …`) | Chromium binary not installed | `npx playwright install chromium` |
