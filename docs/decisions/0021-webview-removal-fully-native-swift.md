# 0021 — Remove WKWebView ghost; fully-native Swift macOS app

- Status: accepted
- Date: 2026-05-05

## Context

Phase 1a mounted a full-bleed `WKWebView` pointed at the Node sidecar (`localhost:3030`).
Phases 2–5 progressively replaced every visible piece of that React UI with native Swift
views: file tree, file viewer (STTextView + tree-sitter), brain (Metal GPU), chat
input/stream, terminal, source-control panel, quick-open, shortcuts sheet, project picker
toolbar, status bar, agents footer, confirm flow.

As of Phase 5f the WebView is `opacity(0.0)` in `ContentView.webIsland` — a ghost, fully
occluded by native overlays. It is kept mounted solely to run the `WKScriptMessageHandler`
bridge: React announces 14 types of state to Swift via `window.marvinShell.postMessage(…)`,
and Swift dispatches 5 command types back into React via `evaluateJavaScript`. No visible
pixel of the WebView reaches the user.

The six remaining web responsibilities that keep the ghost alive:

| Bridge message | Web source | What it drives natively |
|---|---|---|
| `projects-changed` / `project-changed` | `useProjects()` hook | File → Open Recent menu, window subtitle |
| `permission-changed` / `panes-changed` / `personality-changed` / `theme-changed` / `models-changed` | `useMarvinPrefs()` localStorage | Setup popover, Layout popover, About panel |
| `cost-changed` | `<CostPill>` polling `/api/cost` | Bottom status bar cost segment |
| `branch-changed` | `<BranchBadge>` polling `/api/files/status` | Window subtitle branch + dirty pip |
| `session-changed` | `useChatStream` | ChatPreviewModel hydration |
| `marvin-state-changed` / `busy-changed` | Web SSE state machine | Brain particle profile, menu-bar icon |

Every one of these responsibilities has a direct API route or can be derived from the SSE
stream that `ChatService` already consumes. The ghost WebView adds ~12 MB of RAM, one V8
heap, and a bespoke bridge protocol as the sole benefit.

Keeping the WebView alive while the app is visually fully native makes the architecture
harder to reason about: future contributors must understand *two* state sources for every
`MarvinBridge` field, and any new feature must decide which side owns it. Removing the
ghost makes `MarvinBridge` a pure Swift `@Observable` state bucket written only by Swift
services.

The Node sidecar (`next start`) is NOT removed. It owns the Claude Agent SDK runtime,
credential storage, tool execution, and all API routes. This decision cements the
two-process architecture (Swift shell + Node API) as the deliberate long-term shape of the
macOS app, not as residue of an incomplete migration. See "Two-process contract" below.

## Decision

Remove `WebView.swift` and all `WKScriptMessageHandler` / `evaluateJavaScript` code from
the Swift app. Port each of the six remaining web responsibilities to a Swift service that
calls the sidecar API directly via `URLSession`. `MarvinBridge` retains its `@Observable`
fields but they are written by Swift services rather than bridge messages.

**Milestone order (WebView stays mounted until M5):**

- **M1 — NativePrefs + one-shot localStorage migration.** New `NativePrefs.swift`
  (`@Observable`, `UserDefaults`-backed). On first launch (detected by absence of
  `UserDefaults["marvin.migrated_prefs_v1"]`), migrate the five pref keys from the
  WebView's `localStorage` to `UserDefaults`. Sequencing: migration runs inside
  `ContentView.webIsland` via an `.onAppear` task on the `WebView` view, which guarantees
  the `WKWebView` is mounted and `evaluateJavaScript` can reach `localStorage`. It is an
  `async` call on `@MainActor`; `NativePrefs` reads `UserDefaults` synchronously but does
  NOT block the main thread — `NativePrefs.init()` reads whatever is in `UserDefaults` at
  that point (defaults if migration hasn't run yet), and a second `.onChange(of:
  migrationComplete)` observer in any view that cares can react when migration finishes.
  In practice `permissionStrategy` is the only safety-relevant pref, and the window
  chrome is not interactive until after the WebView loads (health probe passes first), so
  the migration completes well before the user can start a turn. During M1–M4 the
  WebView is still mounted, so the web side may still write `localStorage` on pref
  changes. `NativePrefs` wins for any field the user changes via native UI (the write
  goes to `UserDefaults`); web-side-only changes (via the now-hidden web settings panel)
  are irrelevant because the web UI is not visible. No two-write conflict is possible from
  the user's perspective. `ChatAgentsFooter` writes to `NativePrefs` directly from M1 on.

- **M2 — ProjectsService.** New `ProjectsService.swift` (`@Observable` singleton). Loads
  `GET /api/projects` on init; retries with 1s / 2s / 4s exponential backoff (max 3
  retries) because the sidecar may still be starting when the Swift app first launches.
  Exposes `addProject(workDir:name:)` → `POST /api/projects { workDir, name, setActive:
  true }`, `removeProject(id:)` → `DELETE /api/projects?id=`, `setActive(id:)` →
  `PUT /api/projects/active { id }`. Drag-drop folder (`handleFolderDrop` in
  `ContentView`) calls `addProject` directly with `setActive: true` — **no confirmation
  dialog**; the user performed the drop intentionally, and the immediate project switch is
  the feedback. Open Recent menu reads from `ProjectsService` instead of `bridge.projects`.
  On launch, `ProjectsService.init()` also fires `ChatPreviewModel.hydrateInitial()` once
  it has the active project id — this replaces the `session-changed` bridge message for
  the initial hydration case (before the user switches projects).

- **M3 — CostService + BranchService.** Timer-based pollers. Both pause when
  `NSApp.isActive == false`. On fetch error (network failure, sidecar crash) both
  services: (a) keep the last-known value in the UI (no "—" flash on transient errors),
  (b) apply a 5s retry delay before the next attempt, (c) clear the displayed value only
  after 3 consecutive failures (signals the sidecar is genuinely down). `CostService`
  polls `GET /api/cost?projectId=` every 30 s; restarts timer on project switch; clears
  `bridge.costSummary` immediately on project switch so a stale prior-project cost is
  never shown. `BranchService` polls `GET /api/files/status?cwd=` every 15 s; restarts
  on project switch and on `ChatService.turnDidComplete` notification (so the dirty pip
  updates right after a turn that wrote files). Both write `MarvinBridge` fields directly.

- **M4 — Native session routing + marvin-state.** `ChatPreviewModel` already derives
  marvin-state inside `ChatStreamReducer` (Phase 2 port). Wire the output to write
  `MarvinBridge.marvinState` directly after each reducer step, eliminating the
  `marvin-state-changed` bridge dependency. Session hydration is triggered by
  `ProjectsService.activeProjectId` change (replacing the `session-changed` bridge
  message); `ChatService.fetchSession` already performs the `GET /api/sessions?projectId=`
  call — just needs the trigger to come from Swift instead of the bridge.

- **M5 — Delete WebView.** Once M1–M4 are green and all bridge message types have been
  retired: remove `WebView(url: sidecarURL)` from `ContentView.webIsland`, delete
  `WebView.swift`, strip `WKScriptMessageHandler` + `install(on:)` + `injectedScript`
  from `Bridge.swift`, remove `import WebKit` from all Swift files, remove
  `WebViewCommands` environment object from the scene. `FindBarView` (⌘F over the WebView
  DOM) is removed as a known regression — see "Consequences" below.
  On the web side: **delete `apps/web/src/lib/marvin-shell.ts` in its entirety** (all
  functions are either announce functions that become dead code, or the `isSwiftShell()`
  detection which only makes sense when a WebView is present). Update all import sites in
  the Next.js app to remove `announce*` and `isSwiftShell` calls. **Delete the
  `announcePermission` and `announcePanes` call sites from `use-prefs.tsx`** but keep the
  file — it owns the localStorage prefs context for the web UI path, which may still run
  standalone. The full file list to clean up: `marvin-shell.ts` (delete), `use-prefs.tsx`
  (remove 3 announce import + call sites), `page.tsx` (remove any remaining announce
  calls), and any other component that imports from `marvin-shell`.

## Consequences

**Positive:**
- One state source per `MarvinBridge` field. Future contributors don't need to understand
  the bridge protocol to reason about app state.
- Removes ~12 MB V8 heap + the entire WKWebView rendering pipeline on every launch.
- `Bridge.swift` shrinks from ~670 lines to ~250 lines (the `@Observable` fields + their
  direct-write helpers).
- Removes `WebView.swift` (474 lines), `marvin-shell.ts` announce functions (340 lines).
- `import WebKit` disappears from the Swift target — one fewer framework linked.

**Negative / trade-offs:**
- **Polling latency.** The six bridge messages were push-based (React fired them on every
  state change). The Swift pollers introduce worst-case staleness:

  | Signal | Max staleness | Acceptability |
  |---|---|---|
  | Projects list | On-demand (loaded on launch + after mutations) | Fine |
  | Settings | UserDefaults — instantaneous | Fine |
  | Cost | 30 s | Fine — cost display is informational |
  | Branch + dirty | 15 s | Acceptable — matches typical SCM polling |
  | Session | On project-switch (event-driven) | Fine |
  | marvin-state | 0 — derived from SSE stream | Fine |

- **⌘F find-in-page retired.** `FindBarView` searched the WebView's DOM via
  `WKWebView.find(…)`. With no WebView, this UI becomes dead. Native find will be
  addressed in a future milestone (`NSTextFinder` on `STTextView` for the file viewer,
  content search on the chat transcript). Documented as a known regression at ship time.
- **Settings migration risk.** If the 2s migration timeout elapses (sidecar slow to
  respond, WebView not yet loaded), `NativePrefs` falls back to defaults. The one field
  with security impact is `permissionStrategy` — if it falls back to `auto` when the user
  had `gated`, the next session runs in auto mode. Mitigation: the fallback banner
  (`showAutoModeBanner`) reappears on first turn in auto mode, prompting re-confirmation.
  The 2s timeout is generous for a localhost WebView.
- **Two-process runtime forever.** The Node sidecar cannot be eliminated without porting
  the Claude Agent SDK loop, credential storage, and tool execution to Swift/native. That
  is a separate, larger decision. This ADR locks in Swift+Node as the long-term shape.
- **Drag-drop onboarding flow changes.** `handleFolderDrop` currently dispatches
  `dropped-folder` to React, which shows a "Register project?" dialog in the web UI. After
  removal, Swift must present a native confirmation (or silently add the project, which is
  acceptable given the user performed the drop intentionally).

**Follow-ups created:**
- Native `NSTextFinder` integration for ⌘F in the file viewer and chat transcript.
- `NSOpenPanel`-based "Add Project…" dialog (replaces web project-picker for new users
  who have no projects yet and can't use the now-gone web picker).
- Evaluate moving prefs to a `/api/prefs` endpoint (sidecar-owned JSON file) so prefs are
  portable across shells — deferred until a use case demands it.

## Alternatives considered

- **Keep WebView as a migration shim for one release, delete in N+1.** Adds one release
  of dead code. Rejected because the six ports are well-scoped and the migration is
  low-risk with the existing WebView still mounted for M1–M4. Shipping sooner is better.
- **Move prefs to `/api/prefs` (sidecar-owned JSON) instead of UserDefaults.** Makes
  prefs portable. Rejected as out-of-scope — `UserDefaults` is the standard macOS
  persistence for app-level prefs, and the portability use case doesn't exist yet.
- **Transient off-screen WKWebView for the localStorage migration.** Clean but adds ~30
  lines of lifecycle management. Rejected in favour of reading from the already-mounted
  WebView via `evaluateJavaScript` during M1, while it's still present.

## Two-process contract

This ADR deliberately cements the Swift+Node two-process architecture as the macOS app's
long-term shape:

- The **Swift shell** owns the window, native UI, preferences, and all user-facing state.
  It communicates with the sidecar exclusively via `URLSession` (HTTP/SSE) on
  `localhost:3030`. It never reads Anthropic credentials, never executes shell commands
  on behalf of the agent, and never spawns subprocesses (except the sidecar itself, once,
  at startup via `startSidecar()`).
- The **Node sidecar** owns the Claude Agent SDK runtime, credential storage
  (`~/.claude`), session persistence, tool execution, and all `/api/*` routes. It is the
  trust boundary per ADR-0016.

Removing the WebView does not change this boundary — it eliminates a redundant third
communication channel (the WKWebKit bridge) that was duplicating state the sidecar already
owns.

## Scope of Done

- `WebView.swift` is deleted from the repository.
- `import WebKit` appears in zero Swift source files.
- `MarvinBridge` has zero `WKScriptMessageHandler` conformances or `install(on:)` calls.
- `apps/web/src/lib/marvin-shell.ts` is deleted; `grep -r "marvin-shell"` returns no
  import sites in `apps/web/src/`.
- A fresh user (empty `UserDefaults`) sees correct default prefs (auto permission, marvin
  personality, files + brain panes) on first launch.
- An existing user's `permissionStrategy` survives the migration: if the WebView's
  `localStorage` had `marvin.permissionStrategy = "gated"`, the app launches in `gated`
  mode after M1.
- Project switching, cost display, branch label, and chat hydration all function without
  any `announceX` call from the web side.
- `bin/marvin start && open MARVIN-Swift.app` → projects load, a chat turn completes,
  cost segment updates within 30 s of turn completion, branch label updates within 15 s.
- Sidecar restart mid-session: killing and restarting `bin/marvin start` causes cost and
  branch to show last-known values during the outage and resume correct values within
  one poll cycle after restart (no crash, no stale-project cost shown).

## Related

- Files: apps/macos/MARVIN/WebView.swift, apps/macos/MARVIN/Bridge.swift,
  apps/macos/MARVIN/ContentView.swift, apps/macos/MARVIN/ChatAgentsFooter.swift,
  apps/web/src/lib/marvin-shell.ts, apps/web/src/lib/use-prefs.tsx
- Supersedes: none
- Related: ADR-0016 (swift migration), ADR-0020 (Phase 5 embedded surfaces)
