// marvin-shell — detection + typed messaging for the SwiftUI host.
//
// When MARVIN's web app is hosted inside the Swift native shell
// (`apps/macos/`), the WKWebView's user-content-controller injects
// `window.marvinShell` before any of our JS runs. See
// `apps/macos/MARVIN/Bridge.swift` for the Swift side; this module
// is the web counterpart.
//
// The bridge is one-directional today (web → Swift). Swift → web
// messages will arrive via `evaluateJavaScript` calling globals on
// `window.marvinShell` once specific phases need them; we'll add
// the receiving side here when that happens.

/// Snapshot of the shell global injected by Swift. Frozen on the
/// Swift side, so the values are stable for the lifetime of the
/// page; missing fields mean an older bridge version.
export interface MarvinShell {
  readonly isSwift: true;
  readonly version: string;
  readonly build: string;
  /**
   * Posts a JSON-serializable payload to the Swift side via the
   * `marvin` message channel. Returns `true` if delivery is
   * confirmed (non-throwing roundtrip into WKWebKit), `false` on
   * any error. Fire-and-forget — there's no reply channel.
   */
  postMessage(payload: BridgeMessage): boolean;
}

/**
 * All web → Swift messages share this shape. `type` is the routing
 * discriminator; each type owns its own `payload` schema.
 */
export interface BridgeMessage<T extends string = string> {
  type: T;
  payload?: Record<string, unknown>;
}

declare global {
  interface Window {
    marvinShell?: MarvinShell;
  }
}

/** True iff the page is running inside MARVIN's SwiftUI shell. */
export function isSwiftShell(): boolean {
  return typeof window !== "undefined" && !!window.marvinShell?.isSwift;
}

/**
 * Posts a message on the `marvin` channel. Silent no-op when the
 * page isn't hosted in the Swift shell — callers can fire eagerly
 * without guarding every site.
 */
export function postToShell<T extends string>(
  message: BridgeMessage<T>,
): boolean {
  return window.marvinShell?.postMessage(message) ?? false;
}

/**
 * Posts the current `document.title` to the Swift side so the
 * native NSWindow title can mirror the React-managed value
 * (including the v1.2 `(N)` pending-confirm badge). No-op outside
 * the Swift shell. Empty strings are dropped on the Swift side.
 */
export function announceTitle(value: string): void {
  if (!isSwiftShell()) return;
  postToShell({ type: "title", payload: { value } });
}

/**
 * Snapshot mirrored to the Swift side via `cost-changed`. Matches
 * the shape of the web `<CostPill>`'s `/api/cost` response so the
 * native toolbar popover can render the same fields the web one
 * does (today/7d/lifetime/turns/tokens + daily history). All fields
 * are USD and integer-token unless suffixed otherwise.
 */
export interface BridgeCostSummary {
  today: number;
  week: number;
  lifetime: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  daily: Array<{ day: string; costUsd: number; turns: number }>;
}

/**
 * Mirrors the active project's cost summary to the Swift side.
 * Phase 1d.6 — fires from CostPill whenever its `/api/cost` summary
 * refreshes. Pass `null` to clear (no project, no summary). The
 * Swift native popover uses every field; older Swift builds that
 * only consumed `today` keep working because they ignore extras.
 */
export function announceCost(summary: BridgeCostSummary | null): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "cost-changed",
    payload: summary === null
      ? { today: null }
      : { ...summary, currency: "USD" },
  });
}

/**
 * Mirrors the active project name + workDir to the Swift side so
 * the native NSWindow can show the project as a subtitle. Phase
 * 1d.3 — fires on project-changed transitions in `useProjects()`.
 * Sending `null` for both clears the native subtitle (no project).
 */
export function announceProject(
  name: string | null,
  workDir: string | null,
): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "project-changed",
    payload: { name, workDir },
  });
}

/**
 * Mirrors the active git branch + dirty-count to the Swift side so
 * the native NSWindow subtitle can include "project · branch" with
 * a dirty indicator. Phase 1d.7 — fires from `<BranchBadge>` after
 * every `/api/files/status` refresh. Pass nulls when there's no
 * project, or when the workDir isn't a git repo.
 */
export function announceBranch(
  branch: string | null,
  dirtyCount: number,
): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "branch-changed",
    payload: { branch, dirtyCount },
  });
}

/**
 * Mirrors the user's currently-selected models to the Swift side
 * so the native About panel can show "executor: claude-X" instead
 * of just the sidecar's default model. Phase 1d.15 — fires on
 * model-picker changes from `useMarvinPrefs().setModels`. Both
 * fields nullable; null means "fall back to sidecar default".
 */
export function announceModels(
  executor: string | null,
  advisor: string | null,
): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "models-changed",
    payload: { executor, advisor },
  });
}

/**
 * Mirrors the active personality ("marvin" | "neutral") to the Swift
 * side so the About panel can show which mode MARVIN is in without
 * the user having to open the web Settings popover. Phase 1d.32 —
 * fires on every personality change in `useMarvinPrefs`.
 */
export function announcePersonality(personality: "marvin" | "neutral"): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "personality-changed",
    payload: { value: personality },
  });
}

/**
 * Mirrors a coarse "MARVIN is busy / idle" signal to the Swift side
 * so the menu-bar status item can swap between the idle (outlined
 * nodes) and active (filled nodes) Brain Circuit variants while a
 * turn is in flight. Phase 1d.20 — derived from `useChatStream`'s
 * `marvinState` (anything that isn't "idle" or "error" counts as
 * busy). Cheap to call on every state change; the Swift side
 * dedupes redundant updates.
 */
export function announceBusy(busy: boolean): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "busy-changed",
    payload: { busy },
  });
}

/**
 * Mirrors the active theme ("light" | "dark") to the Swift side so
 * the SwiftUI chrome (title bar, About panel, Settings) follows
 * the user's web-side theme pick. Phase 1d.17 — fires from a
 * MutationObserver on `<html data-theme>` in the bridge component.
 * Without this, picking dark inside the WebView leaves the title
 * bar light, which reads as a visual mismatch.
 */
export function announceTheme(theme: "light" | "dark"): void {
  if (!isSwiftShell()) return;
  postToShell({
    type: "theme-changed",
    payload: { value: theme },
  });
}

/**
 * One-shot hello on mount. Confirms the channel works end-to-end
 * and gives the Swift side a build identifier it can log alongside
 * its own. Safe to call repeatedly — Swift just logs each one.
 *
 * Also stamps `<html data-host-shell="swift">` so CSS rules can
 * adapt without re-running the UA detection. Phase 1d will use this
 * to hide the web-rendered top bar once NSToolbar replaces it.
 */
export function announceShell(): void {
  if (!isSwiftShell()) return;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.hostShell = "swift";
  }
  postToShell({
    type: "hello",
    payload: {
      shellVersion: window.marvinShell?.version,
      shellBuild: window.marvinShell?.build,
      // `process.env.NEXT_PUBLIC_*` would be the orthodox source for
      // a build id, but we don't currently expose one and adding the
      // env wiring is out of scope for the bridge bootstrap. The
      // Swift side mainly cares that the channel works.
      reactHref: typeof location !== "undefined" ? location.href : null,
      ts: Date.now(),
    },
  });
}
