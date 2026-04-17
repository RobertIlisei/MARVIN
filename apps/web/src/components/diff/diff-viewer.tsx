"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";

import type { DiffOnMount } from "@monaco-editor/react";

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  { ssr: false, loading: () => <DiffSkeleton /> },
);

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  php: "php",
  sh: "shell",
  zsh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  xml: "xml",
};

function langFor(pathOrName: string): string {
  const name = pathOrName.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s === "" ? 0 : s.split("\n").length;
}

function DiffSkeleton() {
  return (
    <div className="flex h-[240px] items-center justify-center text-[11px] text-[color:var(--color-fg-faint)]">
      mounting editor…
    </div>
  );
}

export function DiffViewer({
  filePath,
  original,
  modified,
  maxHeight = 420,
}: {
  filePath: string;
  original: string;
  modified: string;
  maxHeight?: number;
}) {
  const language = useMemo(() => langFor(filePath), [filePath]);

  const totalLines = Math.max(countLines(original), countLines(modified));
  // Roughly 19px per line + chrome; clamp to maxHeight.
  const height = Math.min(maxHeight, Math.max(160, totalLines * 19 + 24));

  const onMount: DiffOnMount = (_editor, monaco) => {
    // Define a minimal MARVIN theme so the diff sits on our dark canvas
    // instead of the default off-black monaco background.
    monaco.editor.defineTheme("marvin-dark", {
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
    });
    monaco.editor.setTheme("marvin-dark");
  };

  return (
    <div
      className="overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]"
      style={{ height }}
    >
      <DiffEditor
        height="100%"
        original={original}
        modified={modified}
        language={language}
        theme="marvin-dark"
        onMount={onMount}
        options={{
          readOnly: true,
          renderSideBySide: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbers: "on",
          renderWhitespace: "selection",
          wordWrap: "on",
          diffAlgorithm: "advanced",
          renderOverviewRuler: false,
          glyphMargin: false,
          folding: false,
          padding: { top: 8, bottom: 8 },
        }}
      />
    </div>
  );
}
