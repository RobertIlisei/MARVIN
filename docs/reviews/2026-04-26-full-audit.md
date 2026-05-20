# MARVIN — Full audit, 2026-04-26

**Scope.** Backend / runtime, frontend (Next.js shell), UI/UX every screen,
performance & reliability, architecture & code health.

**Method.** Started with the knowledge graph (Golden Rule 7), fell back
to direct file reads when the graph turned out to be poisoned (see
finding #1). Read the heart of the runtime (sdk-runner, tool policy,
auth, fs-sandbox, fs-constants), the chat surface (page.tsx,
use-chat-stream, chat-input, message-view, tool-call-card,
confirm-prompt), and the cross-cutting chrome (top-bar, settings-panel,
source-control-panel, file-viewer, brain-liquid). Lined up findings
against the existing CLAUDE.md, REVIEW.md (root), and ADR set.

**Severity legend.** 🔴 Important (correctness, security, golden-rule
violation, broken behaviour) · 🟠 High (UX or architecture, ships but
hurts) · 🟡 Nit (cleanup).

**Headline.** MARVIN's foundations are solid. The runtime/permission
gate, fs sandbox, git argv-guards, and tool policy are well-considered
and well-tested. The pain is concentrated in three places: (a) the
knowledge graph is currently mis-rooted, which silently disables
Golden Rule 7; (b) the top bar and empty-state hero are visually
overloaded; (c) the high-stakes confirm flow is rendered with the same
visual weight as a normal tool card. Top-five fixes are listed at the
bottom; mockups for those land alongside this file.

---

## 🔴 Important

### 1. Knowledge graph mis-rooting — RECLASSIFIED to 🟡 (false alarm + smoke check shipped)

**Status update 2026-04-26 (afternoon).** The original finding was
based on `mcp__graphify__*` tool calls that returned `J.A.R.V.I.S/...`
nodes. That MCP server is a Cowork-session-level graphify pointing at
a different repo entirely — **not** MARVIN's in-process `marvin-graph`
MCP. MARVIN's actual on-disk `graphify-out/graph.json` is healthy:
861 nodes with 784 (91.1 %) MARVIN-rooted (paths under
`apps/ packages/ docs/ bin/ scripts/` or absolute paths containing
`/marvin/`). Verified by direct read of the file.

So Golden Rule 7 was never disabled in MARVIN itself; it was disabled
in the audit author's environment, and the audit confused the two.

**What actually shipped.** The smoke check that was the audit's
"Fix" remediation landed anyway — `bin/marvin doctor` now runs
`check_graph()`, which parses `graphify-out/graph.json`, asserts ≥ 5 %
of nodes are MARVIN-rooted, and emits a `warn` line + rebuild hint
otherwise. Defence in depth — if the graph drifts in the future this
catches it before the user runs into MCP nonsense answers.

**Carry-forward.** Routine refresh (`graphify . --rebuild`) belongs in
the user's regular workflow whenever PLAN / personality / docs change
— per the existing instructions in CLAUDE.md's graphify section.
The audit no longer flags this as 🔴.

**Citations.** `bin/marvin:check_graph` (added 2026-04-26);
`graphify-out/graph.json` (861 nodes verified MARVIN-rooted).

---

### 2. `auto` permission strategy = silent full bypass

`packages/runtime/src/sdk-runner.ts:231` defaults `permissionStrategy`
to `"auto"`. Line 306 maps that to
`permissionMode: "bypassPermissions"` and skips installing
`canUseTool` entirely. The README/PLAN sells this as a feature
("matches `claude --dangerously-skip-permissions`"). It is. It is
also surprising — a fresh user with default env runs every Edit /
Write / Bash without a confirm prompt. The only protection is the
hard-deny regex set at `packages/tools/src/policy.ts:50-57`, which
matches `rm -rf /` literal but **does not match** `rm -rf
$HOME/important` or `rm -rf ../`. There is no audit log of
auto-allowed mutations.

**Why it matters.** REVIEW.md enumerates "Bypass the structural
confirm gate" as the canonical Important finding. The default
permission posture *is* a bypass — by design. If that's intentional
(it is — see Golden Rule 3 in CLAUDE.md), the design needs surfacing
to the user, not just to a maintainer reading source.

**Fix.** Two separate things, in order of effort:
- Add a one-time first-run banner: "MARVIN auto-allows file edits and
  shell commands. Switch to gated mode if you want to confirm each
  call. (link to settings)" — show in the empty-state hero.
- Tighten `BASH_HARD_DENY`: add `\brm\s+-r[fF]?\s+(\$HOME|~|\.\./)`
  and `\brm\s+-r[fF]?\s+/[^\s]+\s*$` (any rooted path). Cover the
  obvious shells.
- Audit log every auto-allowed Edit/Write/Bash to
  `<workDir>/.marvin/auto-audit.jsonl`. Read-side surface: a
  "recent auto-allows" tab in Settings.

**Citations.** `packages/runtime/src/sdk-runner.ts:60-71`,
`231`, `301-307`; `packages/tools/src/policy.ts:50-57`.

---

### 3. `KNOWN_TOOL_NAMES` excludes `Task` and `NotebookEdit`

`sdk-runner.ts:119-128` defines a fixed 8-name set; `classifyToolCall`
at line 209 explicitly *allows* anything outside it ("not in the gated
set"). Comment on line 207 says these are "sandboxed or delegate back
to tools we already gate."

That's true for the `scout` subagent (`sdk-runner.ts:146-200`) — it
has `disallowedTools: ["Edit", "Write", "Bash", "NotebookEdit"]`,
which is the SDK-level backstop ADR-0014 promises. It is **not** true
for a generic `Task` call with no `subagent_type` (or a different
type). NotebookEdit is similarly unprotected.

**Fix.** Either:
- Add `Task` and `NotebookEdit` to `KNOWN_TOOL_NAMES` and classify
  Task as `confirm` by default (override only when `subagent_type`
  matches a sanctioned name).
- Or document explicitly in `personality.ts`: "MARVIN must never spawn
  a `Task` without `subagent_type: "scout" | "general-purpose"`."
  Currently personality.ts mentions both but doesn't forbid the bare
  form.

**Citations.** `packages/runtime/src/sdk-runner.ts:119-128`,
`146-200`, `202-216`.

---

### 4. `applyHoneycombTelemetryEnv` mutates `process.env` per turn

`sdk-runner.ts:239` calls `applyHoneycombTelemetryEnv(cwd)`, which
(per the file's own JSDoc on lines 234-238) mutates global
`process.env` so the spawned Claude CLI inherits OTEL_* vars. That's
correct for a single in-flight turn — but `runAgent` is invoked
detached (`apps/web/src/app/api/chat/route.ts:133` —
`void runAgentDetached()`). Two concurrent turns for two different
projects with two different Honeycomb configs race on `process.env`;
whichever wins last contaminates both turns' traces.

**Fix.** Pass the env into `query({ options: { env: ... } })` per
call rather than mutating global state — the SDK supports it. If the
Agent SDK doesn't, mediate via a per-turn `child_process` spawn. As
a quick mitigation: serialise concurrent turns via a per-process
mutex (single-user app, single SDK at a time is fine).

**Citations.** `packages/runtime/src/sdk-runner.ts:233-239`;
`packages/runtime/src/honeycomb-telemetry.ts` (read for shape, not
quoted).

---

### 5. Confirm prompts have no timeout

`sdk-runner.ts:269-281` returns `new Promise<PermissionResult>`. The
resolver is registered in the confirm registry; the SDK then awaits
it indefinitely. If the user closes the tab without deciding, the
turn hangs. `clearTurnConfirms(turnId)` in `finally` (line 374) only
fires *after* the SDK loop returns — which it cannot, because the
loop is awaiting on a confirm. Chicken/egg.

**Fix.** Wrap the resolver in `Promise.race` with a configurable
timeout (default 5 min). On timeout, auto-deny with reason
"timeout — no user response in 5 min." Bonus: surface a "stale
confirm" notice in the chat panel after 60 s.

**Citations.** `packages/runtime/src/sdk-runner.ts:268-282`,
`372-375`.

---

### 6. FileViewer "save" path is broken — comment in code admits it

`apps/web/src/components/file-viewer/file-viewer.tsx:76-100`. When
the user closes a dirty file the unsaved-guard offers `save / discard
/ cancel`. The handler at line 89 just early-returns and tells the
user to Cmd-S manually:

```
// The editor owns the content; we can't trigger save from here
// without lifting state. Simplest: ask the user to Cmd-S first
// via a visual cue and don't close. A future refactor can expose
// an imperative save() handle.
return;
```

The "save" button appears, click does nothing. Users will think the
guard is broken (it is).

**Fix.** Lift Monaco save through a ref:
```ts
const saveRef = useRef<() => Promise<void>>();
<MonacoEditor onReady={(api) => { saveRef.current = api.save; }} ... />
```
Then in `handleClose`, await `saveRef.current?.()` before closing.

**Citations.** `apps/web/src/components/file-viewer/file-viewer.tsx:76-100`.

---

### 7. No project-isolation check before chat dispatch

`apps/web/src/app/api/chat/route.ts:83`:

```ts
const cwd = body.cwd?.trim() || process.cwd();
```

If a client sends a chat request without `cwd` (no project picked,
empty-state hero), the route falls back to **MARVIN's own
`process.cwd()`** — i.e. `/path/to/marvin/`. Hello,
self-modifying agent. Golden Rule 4 ("the user's project is a
separate workspace") and ADR-0005 (per-project isolation) both forbid
this.

The frontend defends against it (`page.tsx:285` — `handleSend` early-
returns when `!cwd`), but the API has no equivalent guard.

**Fix.** In the chat route, return 400 if `cwd` is missing or
empty. Defence in depth: validate `cwd !== process.cwd()` and `cwd
!== <MARVIN install root>` and `cwd` exists / is a directory.

**Citations.** `apps/web/src/app/api/chat/route.ts:83`;
`apps/web/src/app/page.tsx:285-296`; ADR-0005.

---

## 🟠 High (UX / architecture)

### 8. Top bar overload — 17+ controls on one strip

`apps/web/src/components/shell/top-bar.tsx`. The strip holds: marvin
logo, v1 chip, project picker, branch badge, cost pill, perms toggle,
models picker, voice toggle, theme toggle, 5 pane toggles, "new
session", ⚙, ?. That's 17 interactive elements. Three (perms /
models / voice) are gated by `xl:` and `2xl:` Tailwind breakpoints —
they hide on screens narrower than 1280-1536px. Below those widths,
the controls don't degrade well (the Settings panel says "Models,
theme, permissions, project — in the top bar," but on narrow
viewports they aren't there either).

**Fix.** See mockup `top-bar-redesigned.html`. Collapse perms /
models / voice into a single "Setup" button that opens a popover
with all three. Move pane toggles into a single "Layout" dropdown
keyed to existing kbd shortcuts. End state: 7 controls (logo,
project, branch, cost, layout, setup, ?), tidy at 1024px+.

**Citations.** `apps/web/src/components/shell/top-bar.tsx:184-243`.

---

### 9. Chat surface is squeezed (~37 % of viewport)

`apps/web/src/app/page.tsx:807-815`. The right side panel
`defaultSize={37}` with `maxSize={55}`. With files at 17 % and centre
at 46 %, chat lands at 37 %. On a 1440px display that's ~530px usable
text width — Cursor is 720-820px, ChatGPT 760-960px in their
chat-only modes. MARVIN's chat reads cramped, especially when
`tool_use` cards expand inline.

The brain panel inside the side column also eats ~40 % of the
column's vertical space (`defaultSize={38}, maxSize={65}` at line
826) — for a decorative element. Default-on (`DEFAULT_PANES.brain:
true`).

**Fix.** Two options, mockup shows option A:
- A. Default `panes.brain: false`, surface a small live state
  indicator in the status row above chat (already exists,
  `StatusBar`). Expose the brain via the existing pane toggle for
  users who want it.
- B. Move chat to centre column, push the work pane (file viewer,
  preview, terminal) to the right. Closer to Cursor's layout. Bigger
  refactor.

**Citations.** `apps/web/src/app/page.tsx:78-84`, `820-862`, `807-815`.

---

### 10. Empty-state hero is busy

`apps/web/src/app/page.tsx:498-627`. Stack: 460 × 460 hero brain orb
+ advisor orb + scout orb + 2 coordinate marks + status chip with
date + h1 "marvin." + tagline + paragraph + 4 capability chips + 3
example prompts + blockquote. ~12 visual elements before the user
sees the input.

The editorial framing is on-brand — but compare ChatGPT (4 prompts +
1 tagline) and Cursor (3 prompts + 1 line). MARVIN's first-run TTI
to "I can type" is dominated by reading copy.

**Fix.** See mockup `empty-state-redesigned.html`. Keep the brain
(it's MARVIN's identity). Drop the coordinate marks, the
"capabilities" chips (the example prompts already imply the
capability set), and the blockquote (move to a tooltip on the
wordmark). Land 6 elements: brain · wordmark · tagline · 3 example
prompts · input.

**Citations.** `apps/web/src/app/page.tsx:498-627`.

---

### 11. Confirm prompts have the same visual weight as completed tool cards

`apps/web/src/components/chat/confirm-prompt.tsx:65-66` border at
`accent-deep/40`, bg at `accent-glow/40`. `tool-call-card.tsx:104` is
`bg-bg-elev/60`. Same neighbourhood. The "allow" button at
`confirm-prompt.tsx:135` is `border-success/40 bg-success/10
text-success` — a 10 % opacity fill on a low-saturation success tone.
"Deny" is even quieter (no fill at all).

Result: when MARVIN proposes `Bash: rm -rf node_modules` (or worse),
the confirm card fades into the chat. There's no badge in tab title,
no system notification, no audible cue. If the user is alt-tabbed,
they miss it. Combined with finding #5 (no timeout), the turn just
… stops.

**Fix.** See mockup `confirm-prompt-redesigned.html`. Filled "allow"
button. Stronger border (1.5px solid accent). Subtle pulse animation
on first render. `document.title` prefix `(!)` while a confirm is
pending. Optional: `Notification.requestPermission()` on first
session, fire one when a confirm appears and the tab is hidden.

**Citations.** `apps/web/src/components/chat/confirm-prompt.tsx:65-184`;
`apps/web/src/components/chat/tool-call-card.tsx:104`.

---

### 12. Tool-call expand affordance hidden until hover

`apps/web/src/components/chat/tool-call-card.tsx:125`. The `+` /
`−` toggle is at `opacity-0 group-hover:opacity-100`. On touch
devices users never see it. On desktop it's discoverable but
non-obvious — and the entire card is clickable, so the toggle is
redundant signage anyway.

**Fix.** Drop to `opacity-50` at rest, `opacity-100` on hover. Or
remove the chevron and rely on a chevron rotation on the icon
column.

**Citations.** `apps/web/src/components/chat/tool-call-card.tsx:125-127`.

---

### 13. Auto-scroll fires unconditionally on every message change

`apps/web/src/app/page.tsx:268-272`. Every messages re-render
sets `scrollTop = scrollHeight`. If the user scrolls up to read a
prior tool result while a stream continues, they get yanked back to
bottom on the next chunk.

**Fix.** Sticky-bottom with threshold:
```ts
const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
if (isAtBottom) el.scrollTop = el.scrollHeight;
```
Surface a "↓ jump to latest" pill when not at bottom and new content
arrives.

**Citations.** `apps/web/src/app/page.tsx:267-272`.

---

### 14. Stream-end recovery is text-only — no retry button

`apps/web/src/components/chat/use-chat-stream.ts:225-249`. When
the stream closes without `turn.completed | turn.error`, the hook
appends a text block "⚠ Stream ended without a result. Check the
server logs (auth, SDK crash, or cwd doesn't exist)." That's the
entire affordance.

**Fix.** Render a structured error block (`type: "error"` with
`retry`/`dismiss` actions). Retry → re-`POST /api/chat` with the
same message + sessionId.

**Citations.** `apps/web/src/components/chat/use-chat-stream.ts:225-249`.

---

### 15. ChatInput textarea has no aria-label; buttons rely on `title`

`apps/web/src/components/input/chat-input.tsx:68-108`. The
`<textarea>` has a placeholder but no `aria-label` /
`aria-labelledby`. Send and stop buttons have `title` (tooltip) but
no `aria-label`. Screen readers will announce the placeholder text
which changes by state — confusing.

**Fix.** `<textarea aria-label="message to MARVIN">`. `<button
aria-label="send message">send ⏎</button>` (the visible text is
fine but explicit aria is clearer).

**Citations.** `apps/web/src/components/input/chat-input.tsx:68-108`.

---

### 16. `localStorage` proliferation, no central API

7 keys in `page.tsx:61-68` (`marvin.personality`,
`marvin.model.executor`, `marvin.model.advisor`,
`marvin.permissionStrategy`, `marvin.panes`, `marvin.session.<id>`)
plus `marvin.fileTree.openDirs:<cwd>` in
`apps/web/src/components/file-tree/file-tree.tsx:64`. Each effect
has its own try/catch swallowing errors. There's no "reset all
settings" path; users debugging a UI quirk have to clear every key
manually.

**Fix.** Single `usePersistedPrefs` hook keyed on a typed `Prefs`
object. Surface a "Reset MARVIN preferences" button in Settings.
Same pattern as a tiny zustand persist middleware, no library
required.

**Citations.** `apps/web/src/app/page.tsx:61-194`;
`apps/web/src/components/file-tree/file-tree.tsx:60-84`.

---

### 17. BrainLiquid runs at full intensity always, no `prefers-reduced-motion`, no visibility pause

`apps/web/src/components/brain/brain-liquid.tsx`. Profile `idle`
runs 4,500 particles at `dotR: 1.0`, `dens: 0.7`, in a tight RAF
loop (`raf = requestAnimationFrame(step)` at line 291). No `if
(document.hidden) return;` check. No `@media (prefers-reduced-motion:
reduce)` shortcut. On a battery-pressed laptop this draws ~3-5 W
continuously while idle — for visual flair behind the chat.

**Fix.**
```ts
const onVis = () => { running = !document.hidden; };
document.addEventListener('visibilitychange', onVis);
// in step():
if (!running) { raf = requestAnimationFrame(step); return; }
```
And:
```ts
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduced) { profile = { ...profile, N: 800, trail: 1.0 }; }
```

**Citations.** `apps/web/src/components/brain/brain-liquid.tsx:51-58`,
`291`, `520-522`.

---

### 18. `page.tsx` is a 923-line god component with an 18-prop bag to TopBar

`apps/web/src/app/page.tsx`. After A2 extracted TopBar, the parent
still owns: project state, personality, executor model, advisor
model, permission strategy, panes (5 booleans), selected path, left
column tab, session refresh key, shortcuts open, settings open,
quick-open open, picker open signal, hero draft, hero draft key,
plus seven persistence effects. 18-prop drilling to TopBar
(`page.tsx:460-489`).

**Fix.** Pull the persisted prefs (personality, models, permission,
panes, leftColumnTab) into a single context or a `usePrefs()` hook;
have TopBar / SettingsPanel read directly. `useChatStream` is
already a hook — the same shape works for prefs. Cuts ~150 lines
and 12 props off `Home`.

**Citations.** `apps/web/src/app/page.tsx:86-194`, `460-489`.

---

### 19. Settings dialog footnote misleads on narrow viewports

`apps/web/src/components/settings/settings-panel.tsx:151`. Footer
says "Models, theme, permissions, project — in the top bar." But
those controls are gated by `xl:`/`2xl:` breakpoints in
`top-bar.tsx:184-202`. On a 1280px screen with the file tree open,
the centre + side columns push them off-canvas. The Settings dialog
becomes the only place to find them, except it doesn't have them
either.

**Fix.** Land #8 (TopBar redesign), then the footnote stays
truthful. Or pull all four controls back into Settings as a quick
fallback.

**Citations.**
`apps/web/src/components/settings/settings-panel.tsx:135-153`;
`apps/web/src/components/shell/top-bar.tsx:184-202`.

---

### 20. No virtualisation on chat scroller or file tree

Two separate cases:
- `apps/web/src/app/page.tsx:873-886` — chat messages render 1:1.
  After 500+ turns the scroller starts dropping frames (each
  `tool_use` card mounts a Monaco diff viewer if expanded; even
  collapsed it's a non-trivial subtree).
- `apps/web/src/components/file-tree/file-tree.tsx` — full tree
  renders. A monorepo with 5000+ files takes seconds to render and
  fights with the file-status poll.

**Fix.** Land `react-virtuoso` (or roll a windowed list with the
Intersection Observer pattern). Chat is the higher leverage of the
two.

**Citations.** `apps/web/src/app/page.tsx:873-886`;
`apps/web/src/components/file-tree/file-tree.tsx` (full file).

---

## 🟡 Nits

### 21. Tool name set is declared in two places

`packages/tools/src/policy.ts:13-21` (`type ToolName`,
`BASE` map) and `packages/runtime/src/sdk-runner.ts:119-128`
(`KNOWN_TOOL_NAMES`). Same set, different files. If one drifts the
other goes silently wrong.

**Fix.** Export `KNOWN_TOOL_NAMES` from `@marvin/tools/policy`,
import in sdk-runner.

### 22. Cancel returns to "idle" before server confirms

`apps/web/src/components/chat/use-chat-stream.ts:254-273`.
`cancel()` aborts the local controller and sets `marvinState = idle`
synchronously, then fires `/api/chat/cancel` as best-effort. If the
SDK is mid-Bash on a long command, the user can send a new message
while the server is still tearing down — second turn gets the same
stream of cli.events.

**Fix.** Hold the UI in a `cancelling` state until /api/chat/cancel
resolves (or its 200/4xx). Show a "stopping…" spinner.

### 23. Hero brain fires three RAF loops on mount

`apps/web/src/app/page.tsx:506-520`. Brain (340px) + AdvisorOrb +
ScoutOrb. Each is its own component with its own animation. On the
hero you also have the constellation (`<div className="constellation"
/>`, line 501) which has CSS animations. That's a lot of motion at
T+0 of opening MARVIN.

### 24. Example prompt "find a bug" is contrived

`apps/web/src/app/page.tsx:583-587` — "messages sometimes arrive
twice. investigate." This bug doesn't exist (the dedup at
`use-chat-stream.ts:794-796` prevents it). For a first-time user the
prompt makes no sense. Replace with something general like "find the
hottest path through the chat stream and flag anything that could
race."

### 25. REVIEW.md at repo root is the *review-rules* doc, not a *review report* — RESOLVED in-place

**Status update 2026-04-26 (afternoon).** The rename to
`REVIEW_RULES.md` was attempted and reverted: the cherry-picked
`pr-review` skill at `.claude/skills/pr-review/SKILL.md` reads
`REVIEW.md` by hard-coded name, and Cowork's sandbox treats the
`.claude/skills/` path as read-only (it's a pinned mirror of the
upstream Anthropic skill bundle). Renaming the root file would have
silently broken the skill until the user manually updated their
local skill copy. Replacement fix: a clarifying header note at the
top of `REVIEW.md` explaining the rules-vs-report distinction and
pointing readers to `docs/reviews/` for actual review reports. The
audit's intent (disambiguate the two genres) is met without the
breakage.

### 26. ChatInput: `eslint-disable-next-line react-hooks/exhaustive-deps`

`apps/web/src/components/input/chat-input.tsx:36`. Comment-free.
`useEffect` depends on `[draft, draftKey]` but the disable suggests
the effect closes over a stale callback. Either explain why or fix
the deps.

### 27. `as unknown as "turn.user"` in chat route

`apps/web/src/app/api/chat/route.ts:126`. Documented inline
("transcript shape is open; cast keeps TS happy"). The comment is
fine — the underlying issue is that `appendSessionTurn`'s shape is
`turn.user | cli.event | turn.completed | turn.error` but the route
also wants to log `turn.started`. Widen the union.

### 28. Stop button styling is muted danger

`apps/web/src/components/input/chat-input.tsx:94`. `bg-danger/10
text-danger`, low-contrast on light bg. For a destructive action,
fill it. (Mockup `confirm-prompt-redesigned.html` shows the same
treatment for "deny.")

---

## Performance & reliability summary

What's good:
- `MessageView` is `React.memo`'d (`message-view.tsx:140`).
- `FileViewer` is dynamic-imported (`page.tsx:21-27`) so Monaco isn't
  in the initial bundle.
- `use-git-status` polls only when `visible: true`
  (`source-control-panel.tsx:45`).
- Refresh-safe turns via the `turn-registry` decoupling are correctly
  implemented (`route.ts:131-181`).
- The chat-stream hook handles partial SSE buffers correctly
  (`use-chat-stream.ts:161-198`).

What needs work (all already cited above):
- BrainLiquid never pauses (#17).
- Auto-scroll yanks the user (#13).
- No virtualisation on chat or file tree (#20).
- No timeout on confirms (#5).
- Cancel races (#22).

---

## Architecture & code health summary

What's good:
- ADR-driven design — 14 ADRs cover the material decisions, and the
  REVIEW.md root doc gives the reviewer a real rubric.
- `fs-constants.ts` shares the deny / ignore lists between LLM and
  user write channels — exactly the drift-prevention REVIEW.md asks
  for.
- `argv-guards.ts` whitelists every user-supplied ref/path/remote
  before it hits git argv.
- Test coverage focused on security-critical layer
  (fs-sandbox, fs-write-policy, argv-guards, scout-agent,
  honeycomb-config). Smart prioritisation.
- 0 `console.log` in `apps/web/src` — errors are routed through the
  UI, not the console.
- One `@ts-nocheck` (brain-liquid), documented in-file. One
  `as unknown as`, documented. Three `eslint-disable-next-line`,
  each rationale-commented.

What needs work:
- Tool-name drift (#21).
- No tests for chat-stream / sdk-runner happy path.
- No tests for `BASH_HARD_DENY` regex coverage (#2 exposes the
  gap — `rm -rf $HOME` slips through).
- `KNOWN_TOOL_NAMES` carve-out isn't enforced (#3).
- `page.tsx` god component (#18).

---

## Top 5 fixes (mockups attached)

Ranked by user-visible impact × effort.

| # | Fix | Effort | Impact | Mockup |
|---|---|---|---|---|
| 1 | Re-root the knowledge graph | 1 hr | 🔴 critical — Golden Rule 7 currently disabled | (no UI mockup, see #1) |
| 2 | Confirm prompt high-stakes treatment + `document.title` badge + timeout | 1 day | 🔴 trust + safety | `confirm-prompt-redesigned.html` |
| 3 | Top bar redesign — collapse to 7 controls | 0.5 day | 🟠 fits 1024px+ cleanly | `top-bar-redesigned.html` |
| 4 | Empty-state hero — drop to 6 elements | 0.5 day | 🟠 first-run TTI | `empty-state-redesigned.html` |
| 5 | Brain RAF pause on `document.hidden` + `prefers-reduced-motion` | 1 hr | 🟠 battery + a11y | (no UI mockup, see #17) |

The mockups are static HTML you can open in a browser; each shows
before / after side-by-side.

---

## Appendix — files read for this audit

Backend / runtime:
`packages/runtime/src/sdk-runner.ts`,
`packages/runtime/src/auth.ts`,
`packages/runtime/src/fs-sandbox.ts`,
`packages/tools/src/policy.ts`,
`packages/tools/src/fs-write-policy.ts`,
`packages/tools/src/fs-constants.ts`,
`apps/web/src/app/api/chat/route.ts`.

Frontend:
`apps/web/src/app/page.tsx`,
`apps/web/src/app/globals.css`,
`apps/web/src/components/chat/use-chat-stream.ts`,
`apps/web/src/components/chat/message-view.tsx`,
`apps/web/src/components/chat/tool-call-card.tsx`,
`apps/web/src/components/chat/confirm-prompt.tsx`,
`apps/web/src/components/input/chat-input.tsx`,
`apps/web/src/components/shell/top-bar.tsx`,
`apps/web/src/components/settings/settings-panel.tsx`,
`apps/web/src/components/source-control/source-control-panel.tsx`,
`apps/web/src/components/file-viewer/file-viewer.tsx`,
`apps/web/src/components/file-tree/file-tree.tsx` (head),
`apps/web/src/components/brain/brain-liquid.tsx` (head + RAF
sites).

Cross-cutting:
`README.md`, `CLAUDE.md`, `REVIEW.md`, `PLAN.md` (head), all 14
ADRs (file list only), `package.json`s of every workspace.

Knowledge graph: `mcp__graphify__graph_stats`,
`mcp__graphify__god_nodes`, `mcp__graphify__query_graph(...)`. The
graph turned out to be polluted (finding #1) so most exploration was
direct file reads — flagged as a deviation from Golden Rule 7
because the rule's prerequisite (a clean MARVIN-rooted graph) was
not satisfied.
