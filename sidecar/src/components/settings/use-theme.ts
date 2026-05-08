"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

function read(): ThemeMode {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

/**
 * Reactive read of `<html data-theme>`. Used by components whose visual
 * layer lives outside React's normal CSS-var cascade (Monaco editor,
 * xterm.js) and therefore need to explicitly re-configure themselves
 * when the theme flips. Default / SSR state is `"light"` to match the
 * DARK_THEME_HANDOFF.md cascade: light is the baseline.
 *
 * Lazy initializer runs on **first render**, reading `data-theme`
 * synchronously on the client. The earlier non-lazy `useState("light")`
 * forced a first-render "light" → effect-phase "dark" transition that
 * was racy with Monaco's dynamic import: when Monaco mounted during
 * that first-render window (cached second-file-open case), it
 * captured `mode="light"` via closure and called
 * `monaco.editor.setTheme("marvin-light")` globally — which is a
 * singleton, so it flipped every existing dark editor back to light
 * on every new file open. The lazy init closes that race: first
 * render already sees `"dark"` when the user is in dark mode.
 *
 * SSR still returns "light" (document is undefined on the server),
 * matching the handoff's baseline.
 */
export function useTheme(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>(() => read());
  useEffect(() => {
    // Belt-and-braces: sync once more in case SSR rendered with
    // "light" and the real `data-theme` was set by the pre-hydration
    // bootstrap script in layout.tsx. Cheap; idempotent.
    setMode(read());
    const mo = new MutationObserver(() => setMode(read()));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, []);
  return mode;
}
