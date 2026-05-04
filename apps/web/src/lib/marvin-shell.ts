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
