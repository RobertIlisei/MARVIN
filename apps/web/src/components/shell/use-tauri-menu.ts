"use client";

/**
 * Wire the Tauri desktop app's native menu bar to MARVIN's existing
 * actions. No-op in a browser tab — the `__TAURI_INTERNALS__` global
 * only exists inside the Tauri webview.
 *
 * See `apps/desktop/src-tauri/src/lib.rs` for the native menu layout
 * and the `marvin:*` IDs this hook maps. Keep the two in sync.
 *
 * Keyboard shortcuts for the items that have accelerators continue to
 * fire via `page.tsx`'s `window.keydown` handler (with
 * `preventDefault()`) — the native menu accelerators are purely
 * display affordances when JS consumes the key event first. Clicking
 * a menu item explicitly *does* dispatch through here.
 */

import { useEffect } from "react";

export interface TauriMenuActions {
  newSession(): void;
  quickOpen(): void;
  openProjectPicker(): void;
  cancelTurn(): void;
  toggleShortcutsHelp(): void;
  togglePane(key: "files" | "graph" | "terminal" | "preview" | "brain"): void;
  openUrl(url: string): void;
}

const ACTION_BY_ID: Record<string, keyof TauriMenuActions | null> = {
  "marvin:new-session": "newSession",
  "marvin:quick-open": "quickOpen",
  "marvin:project-picker": "openProjectPicker",
  "marvin:cancel-turn": "cancelTurn",
  "marvin:shortcuts": "toggleShortcutsHelp",
  "marvin:toggle-files": null, // handled inline via togglePane("files")
  "marvin:toggle-graph": null,
  "marvin:toggle-terminal": null,
  "marvin:toggle-preview": null,
  "marvin:toggle-brain": null,
  "marvin:open-docs": null, // openUrl
  "marvin:open-repo": null,
};

const TOGGLE_BY_ID: Record<string, "files" | "graph" | "terminal" | "preview" | "brain"> = {
  "marvin:toggle-files": "files",
  "marvin:toggle-graph": "graph",
  "marvin:toggle-terminal": "terminal",
  "marvin:toggle-preview": "preview",
  "marvin:toggle-brain": "brain",
};

const URL_BY_ID: Record<string, string> = {
  "marvin:open-docs": "https://github.com/RobertIlisei/MARVIN/blob/main/docs/README.md",
  "marvin:open-repo": "https://github.com/RobertIlisei/MARVIN",
};

function isTauriEnv(): boolean {
  if (typeof window === "undefined") return false;
  return "__TAURI_INTERNALS__" in window;
}

export function useTauriMenu(actions: TauriMenuActions): void {
  useEffect(() => {
    if (!isTauriEnv()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      // Dynamic import so the browser-only bundle doesn't drag Tauri's
      // IPC runtime into its critical path. Next.js lazy-chunks this.
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      unlisten = await listen<{ id: string }>("marvin:menu", (event) => {
        const id = event.payload?.id;
        if (!id) return;

        const toggleKey = TOGGLE_BY_ID[id];
        if (toggleKey) {
          actions.togglePane(toggleKey);
          return;
        }

        const url = URL_BY_ID[id];
        if (url) {
          actions.openUrl(url);
          return;
        }

        const action = ACTION_BY_ID[id];
        if (action && action in actions) {
          // TypeScript narrowing: every non-null action above is a
          // zero-arg method; call it.
          (actions[action] as () => void)();
        }
      });
    })();

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
    // actions is a ref-like bag the caller constructs fresh each render,
    // but we intentionally want a single listener for the lifetime of
    // the component — caller passes a stable object (useMemo or direct).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
