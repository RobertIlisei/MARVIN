# ADR-0045 — Playwright MCP: opt-in, gated browser-automation server

**Status:** Accepted — 2026-06-19
**Touches:** `sdk-runner.ts` (register the first EXTERNAL stdio MCP server,
conditionally; extend `classifyToolCall`), `@marvin/tools/policy` (classify
external MCP tool names — no longer blanket-allow), a settings/opt-in flag
threaded through `runAgent`, `personality.ts` (when to reach for browser tools
vs the existing Bash CLI), `CLAUDE.md` (Browser tools section). Builds on the
permission gate (audit #3), the subagent read-only invariant
([ADR-0030](./0030-dynamic-workflows-read-only-fan-out.md)), and the existing
Bash-CLI browser path (CLAUDE.md ▸ "Browser automation").

## Context

MARVIN can already drive a browser by shelling out to the Playwright **CLI**
via Bash (`npx playwright screenshot …`, scripted `node check.mjs`). That's
fine for one-shot captures but not for **stateful, interactive, tool-driven**
browsing — navigate → snapshot → click → assert, with the model reading the
accessibility tree between steps. The official **Playwright MCP**
(`@playwright/mcp`) exposes exactly that as first-class tools
(`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_evaluate`,
…), which is the right surface for visual verification, e2e checks, and
"doesn't-work-on-my-machine" debugging.

**The blocker is the permission gate.** `classifyToolCall` (sdk-runner.ts)
short-circuits any tool **not** in `KNOWN_TOOL_NAMES` to `allow`:

```
if (!KNOWN_TOOL_NAMES.has(name)) return { decision: "allow", … };  // "MCP etc. … sandboxed"
```

That is safe for MARVIN's four current MCP servers (graph / memory / backlog /
control — all read-only, in-process). It is **not** safe for Playwright MCP,
which ships **code-execution and egress** tools:

- `browser_run_code_unsafe` — runs arbitrary code on the host/runner,
- `browser_evaluate` — evaluates arbitrary JS in the page,
- `browser_navigate` — fetches arbitrary URLs (the same prompt-injection /
  egress surface that made plain `WebFetch` a `confirm`).

Registering the server as-is would let all of those run **ungated even in
`gated` mode** (the short-circuit fires before the gated/auto split). The
**subagent read-only invariant** (ADR-0030) has the same hole — it only governs
`KNOWN_TOOL_NAMES`, so a scout/advisor could drive a browser and execute code.
So the real work isn't "add a server" — it's **gating it correctly**.

## Decision

Add Playwright MCP as an **opt-in, gated** server.

### 1. Register as MARVIN's first external (stdio) MCP server
In `sdk-runner.ts`, conditionally add to `mcpServers`:
```
"playwright": { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] }
```
**Opt-in / off by default** — a browser subprocess per turn is heavy and most
projects don't need it. Threaded through `runAgent` and registered conditionally
(mirroring how `marvin-control`/`wakeupMcp` is only wired when its inputs are
present). The exact toggle (user setting vs per-project) is a plan detail; the
ADR fixes only that it is opt-in and defaults off.

### 2. Classify external MCP tools at the gate (stop blanket-allow)
`policy.ts` gains an explicit classifier for external MCP tool names;
`classifyToolCall` consults it for the `playwright` server instead of
auto-allowing. The split, by capability:

- **auto** (observational / read-only): `browser_snapshot`,
  `browser_take_screenshot`, `browser_console_messages`,
  `browser_network_requests`, `browser_wait_for`, `browser_tabs`.
- **confirm** (state-changing / egress / interaction): `browser_navigate`,
  `browser_navigate_back`, `browser_click`, `browser_type`,
  `browser_fill_form`, `browser_press_key`, `browser_select_option`,
  `browser_hover`, `browser_drag`, `browser_drop`, `browser_file_upload`,
  `browser_handle_dialog`, `browser_resize`, `browser_close`,
  `browser_evaluate`.
- **deny** (arbitrary host code): `browser_run_code_unsafe` — never runs
  without an explicit per-call user override.

(As today, `confirm` only prompts in `gated` mode; in the default `auto`/full-
bypass mode confirm-class runs without a card — Golden Rule 3. The load-bearing
protection is the `deny` on the unsafe escape hatch and the subagent collapse
below.)

### 3. Extend the subagent read-only invariant to external MCP tools
`classifyToolCall` must run the MCP classifier **even when `agentID` is
present**, so the existing collapse applies: a subagent gets only the
**auto-class** browser tools (snapshot / screenshot / console / network / wait /
tabs) — a read-only browser for research — and any `confirm`/`deny` browser tool
is **hard-denied** for sub-agents (Golden Rule 1 / ADR-0030). The fix is to not
short-circuit unknown-MCP-to-allow before the agentID check for this server.

### 4. Guidance
`personality.ts` + `CLAUDE.md`: when the browser MCP is enabled, prefer its
tools for interactive/stateful browser work; keep the Bash CLI for one-shot
captures and full `playwright test` runs. Note `browser_run_code_unsafe` is
denied.

## Consequences

- First-class, stateful browser automation for the model, correctly gated.
- MARVIN gains its first external-process MCP server — a small generalization of
  the `mcpServers` wiring that a future "user-configured MCP servers" feature
  can build on (out of scope here).
- The "all MCP is auto-allowed" assumption is replaced by "trusted in-process
  servers auto-allow; classified external servers go through policy." Existing
  in-process servers are unchanged (still auto).

## Rejected alternatives

- **Register it and rely on `gated` mode.** Doesn't work — the gate
  short-circuits unknown MCP names to `allow` before the gated/auto split.
- **Blanket-allow (status quo for MCP).** Ungated host code execution +
  subagent browser access. The exact hole this ADR closes.
- **Always-on server.** A browser subprocess every turn, for every project —
  wasteful; opt-in instead.
- **Bash CLI only (status quo).** No stateful interactive browsing; the reason
  for this ADR.

## Scope of Done

- [x] Playwright MCP registered as an external stdio server in `sdk-runner`
      (`{type:"stdio", command:"npx", args:["@playwright/mcp@latest"]}`),
      **opt-in, off by default**, conditional like `wakeupMcp`.
- [x] `policy.ts` `mcpToolPolicy` classifies the `playwright` server's tools
      (auto / confirm / deny per §2); `classifyToolCall` consults it before the
      blanket-allow, returning `null` (⇒ blanket-allow) for in-process servers.
- [x] `browser_run_code_unsafe` denied; the existing subagent collapse
      (reused) hard-denies every confirm/deny browser tool for any `agentID`.
- [x] Opt-in `playwrightEnabled` threaded end-to-end (web prefs + Setup popover
      toggle; macOS NativePrefs/Bridge/ChatRequest + Settings ▸ Browser) and
      through the wakeup path; off by default.
- [x] Unit tests: `mcpToolPolicy` (auto/confirm/deny + null for in-process) and
      `classifyToolCall` (allow snapshot / confirm click / deny run_code_unsafe
      / subagent collapse). sidecar tsc clean for touched files; macOS
      `swift build` clean. (Pre-existing `policy.test.ts` WebFetch/WebSearch/
      backgrounded failures are unrelated — confirmed on the stashed tree.)
- [x] `personality.ts` "Browser tools", `CLAUDE.md`, and
      `docs/reference/mcp-servers.md` document CLI-vs-MCP + the `run_code_unsafe`
      deny + the opt-in toggle.

## Addendum — 2026-06-24: GUI-launch PATH bug (the server never spawned)

**Symptom.** With the toggle ON, MARVIN still didn't see the
`mcp__playwright__browser_*` tools — "doesn't know about it".

**Root cause.** A macOS app launched from Finder / Spotlight inherits the
minimal launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), which omits Homebrew
(`/opt/homebrew/bin`) where the user's `node` / `npx` live. `SidecarManager`
spawned the sidecar with `ProcessInfo.processInfo.environment` unmodified, so
`process.env.PATH` (→ `turnEnv` → the SDK → the MCP subprocess) lacked it. The
server config used a bare `command: "npx"`, which therefore **ENOENT'd**; the
stdio server never started and the tools never registered. Verified live: the
running SDK process had `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and no
`@playwright/mcp` child, while `npx` resolved only at `/opt/homebrew/bin/npx`.
(`npx playwright` via the `Bash` tool worked because that runs through a login
shell that sources the user's profile.)

**Fix (two layers, belt-and-braces).**
- `SidecarManager.swift` prepends `/opt/homebrew/bin` + `/usr/local/bin` to the
  sidecar's `PATH` at launch (de-duplicated, order-preserving) — so *every*
  sidecar subprocess resolves Homebrew node regardless of launch method.
- `sdk-runner.ts` adds `enrichedToolPath()` (prepends `dirname(process.execPath)`
  + Homebrew + `/usr/local`), applied to `turnEnv.PATH` and to the Playwright
  server config's `env`, so the exact `npx` spawn resolves even if the sidecar's
  own PATH is minimal.

**Verified.** Under the minimal PATH `npx @playwright/mcp@latest` → `command not
found`; under the enriched PATH → `Version 0.0.76`. Unit test
`enriched-tool-path.test.ts` (4 cases) pins the prepend/dedup/empty-drop
contract; runtime `tsc` + `swift build` clean.
