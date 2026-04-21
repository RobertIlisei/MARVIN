"use client";

/**
 * Shared Monaco theme registration for MARVIN.
 *
 * Historically these theme defs lived inline in `diff-viewer.tsx`. Once
 * the single-file editor (M4) was added, both components needed the same
 * colour palette — so the theme defs moved here and both call `ensure`
 * on mount.
 *
 * The `marvin-dark` / `marvin-light` names mirror the `<html data-theme>`
 * tokens used across the rest of the app. `monaco.editor.setTheme()` is
 * global, so changing it on any one editor flips all of them — which is
 * the behaviour we want.
 */

// This module is purely a side-effecting registration helper; we accept
// Monaco's concrete `Monaco` namespace via the onMount callback rather
// than importing it at module scope (which would force Monaco into the
// server bundle).
type MonacoNamespace = {
  editor: {
    defineTheme(name: string, spec: MonacoThemeData): void;
    setTheme(name: string): void;
  };
};

interface MonacoThemeData {
  base: "vs" | "vs-dark";
  inherit: boolean;
  rules: unknown[];
  colors: Record<string, string>;
}

const DARK: MonacoThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#0d0d12",
    "editor.foreground": "#e8e8ef",
    "editor.lineHighlightBackground": "#14141c",
    "editorLineNumber.foreground": "#585866",
    "editorLineNumber.activeForeground": "#9a9aa8",
    "diffEditor.insertedTextBackground": "#6be4a620",
    "diffEditor.removedTextBackground": "#ff7a7a20",
    "diffEditor.insertedLineBackground": "#6be4a614",
    "diffEditor.removedLineBackground": "#ff7a7a14",
    "editorGutter.addedBackground": "#6be4a6",
    "editorGutter.deletedBackground": "#ff7a7a",
    "editorGutter.modifiedBackground": "#7fd3ff",
    "editorOverviewRuler.border": "#00000000",
  },
};

const LIGHT: MonacoThemeData = {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#faf8f3",
    "editor.foreground": "#1f1d17",
    "editor.lineHighlightBackground": "#f0ede5",
    "editorLineNumber.foreground": "#a09e94",
    "editorLineNumber.activeForeground": "#5a5a50",
    "diffEditor.insertedTextBackground": "#6eb77028",
    "diffEditor.removedTextBackground": "#c96b5c28",
    "diffEditor.insertedLineBackground": "#6eb7701a",
    "diffEditor.removedLineBackground": "#c96b5c1a",
    "editorGutter.addedBackground": "#6eb770",
    "editorGutter.deletedBackground": "#c96b5c",
    "editorGutter.modifiedBackground": "#a58a4a",
    "editorOverviewRuler.border": "#00000000",
  },
};

export type MarvinMonacoTheme = "marvin-dark" | "marvin-light";

export function themeNameFor(mode: "light" | "dark"): MarvinMonacoTheme {
  return mode === "light" ? "marvin-light" : "marvin-dark";
}

/** Register both themes on a Monaco namespace. Idempotent. */
export function ensureMonacoThemes(monaco: MonacoNamespace): void {
  monaco.editor.defineTheme("marvin-dark", DARK);
  monaco.editor.defineTheme("marvin-light", LIGHT);
}

/** Register + activate in one call. */
export function applyMonacoTheme(
  monaco: MonacoNamespace,
  mode: "light" | "dark",
): void {
  ensureMonacoThemes(monaco);
  monaco.editor.setTheme(themeNameFor(mode));
}
