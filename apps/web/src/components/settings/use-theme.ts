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
 */
export function useTheme(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("light");
  useEffect(() => {
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
