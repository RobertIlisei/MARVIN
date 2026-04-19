"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "marvin-theme";

function applyTheme(mode: ThemeMode) {
  if (mode === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

/**
 * Header pill that flips MARVIN between the Claude-Design light baseline
 * (warm paper, ink) and the icy-blue-on-black dark override from
 * `DARK_THEME_HANDOFF.md`. Persists to `localStorage.marvin-theme`;
 * initial paint is handled by the inline bootstrap in `layout.tsx`, so
 * this component only reacts after hydration.
 *
 * Glyph convention per the handoff: ☀ shown while in dark mode (click to
 * go light), ☾ shown while in light mode (click to go dark).
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("light");

  // Read the value the layout script already applied. Falls back to
  // what `<html data-theme>` actually shows so a refresh doesn't flip
  // modes during hydration.
  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    setMode(attr === "dark" ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: ThemeMode = mode === "dark" ? "light" : "dark";
    setMode(next);
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* no storage — stays in-memory for the session */
    }
  };

  const glyph = mode === "dark" ? "☀" : "☾";
  const nextLabel = mode === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`switch to ${nextLabel} theme`}
      title={`switch to ${nextLabel}`}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 text-[13px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}
