"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "marvin.theme";

function applyTheme(mode: ThemeMode) {
  if (mode === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

/**
 * Header pill that flips MARVIN between the warm-ink dark theme (default)
 * and the Claude-Design-derived warm-white light theme. Persists to
 * `localStorage.marvin.theme`; initial paint is handled by the inline
 * bootstrap in `layout.tsx`, so this component only reacts after hydration.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode>("dark");

  // Read the value that the layout script already applied. Fall back to
  // what `<html data-theme>` actually shows so a refresh doesn't flip
  // modes during hydration.
  useEffect(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    setMode(attr === "light" ? "light" : "dark");
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

  const glyph = mode === "dark" ? "☾" : "☀";
  const nextLabel = mode === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`switch to ${nextLabel} theme`}
      title={`switch to ${nextLabel} theme`}
      className="flex h-7 w-7 items-center justify-center rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 text-[13px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}
