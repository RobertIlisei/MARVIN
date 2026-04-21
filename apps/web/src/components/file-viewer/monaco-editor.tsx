"use client";

/**
 * Single-file Monaco editor backed by `/api/files/write/save`.
 *
 * - Loads content via the shared `/api/files/content` endpoint + captures
 *   the on-disk `mtime` from `fs.stat` (returned via a HEAD fetch since
 *   /content doesn't include mtime). We CAS on that mtime on every save.
 * - Cmd-S / Ctrl-S saves.
 * - Dirty state published via `onDirtyChange` so the parent can show the
 *   unsaved-changes guard when the user switches files / projects.
 * - On `409 stale` the editor shows a banner with Reload / Overwrite
 *   choices. "Reload" drops the pending edits, re-fetches, resets the
 *   CAS token. "Overwrite" re-saves without an `expectedMtime` — the
 *   server accepts that as an explicit intent to replace.
 *
 * The editor deliberately REFUSES to mount on `binary: true` or
 * `truncated: true` files — saving a binary as UTF-8 would corrupt it,
 * and saving a truncated file would silently drop the rest. The caller
 * renders the existing read-only panels in those cases.
 */


import type { OnMount } from "@monaco-editor/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyMonacoTheme } from "@/components/settings/monaco-themes";
import { useTheme } from "@/components/settings/use-theme";
import { type EditorConflict, EditorToolbar } from "./editor-toolbar";

const Editor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.Editor),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

// Extension → Monaco language ID. Keep in lockstep with Monaco's
// bundled language registry (https://github.com/microsoft/monaco-editor
// /tree/main/src/basic-languages). Adding an entry for a language
// Monaco doesn't ship will fall back to plaintext — no harm done,
// just no syntax highlighting.
const LANG_BY_EXT: Record<string, string> = {
  // TypeScript / JavaScript
  ts: "typescript",
  tsx: "typescript",
  cts: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  // Data / config
  json: "json",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini", // Monaco doesn't ship TOML; ini is the closest built-in
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  // Markup / docs
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  txt: "plaintext",
  log: "plaintext",
  // Styles
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  // Web
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  vue: "html",
  // Systems + compiled
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  cs: "csharp",
  fs: "fsharp",
  vb: "vb",
  m: "objective-c",
  mm: "objective-c",
  // Scripting
  py: "python",
  pyi: "python",
  rb: "ruby",
  erb: "ruby",
  php: "php",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  jl: "julia",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  cljs: "clojure",
  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  bat: "bat",
  cmd: "bat",
  // Query / data
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  // Infra / build
  tf: "hcl",
  hcl: "hcl",
  dockerfile: "dockerfile",
  proto: "protobuf",
};

// Filename → language. Checked BEFORE the extension map. Covers
// "no extension" well-known files (Dockerfile, Makefile, Gemfile…)
// and filename-specific overrides (package-lock.json → json,
// pnpm-lock.yaml → yaml).
const LANG_BY_FILENAME: Record<string, string> = {
  Dockerfile: "dockerfile",
  Containerfile: "dockerfile",
  Makefile: "plaintext", // Monaco has no makefile grammar
  GNUmakefile: "plaintext",
  Rakefile: "ruby",
  Gemfile: "ruby",
  "Gemfile.lock": "plaintext",
  Procfile: "shell",
  Vagrantfile: "ruby",
  Brewfile: "ruby",
  Podfile: "ruby",
  // Shell dotfiles
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".bash_profile": "shell",
  ".zprofile": "shell",
  ".profile": "shell",
  ".envrc": "shell",
  // Lock files
  "package-lock.json": "json",
  "pnpm-lock.yaml": "yaml",
  "yarn.lock": "plaintext",
  "Cargo.lock": "ini",
  "poetry.lock": "ini",
  // Well-known config files
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".eslintrc": "json",
  ".prettierrc": "json",
};

function langFor(p: string): string {
  const name = p.split("/").pop() ?? "";
  const byFilename = LANG_BY_FILENAME[name];
  if (byFilename) return byFilename;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "plaintext";
}

function EditorSkeleton() {
  return (
    <div className="flex h-full items-center justify-center text-[11px] text-[color:var(--color-fg-faint)]">
      mounting editor…
    </div>
  );
}

export interface MonacoEditorProps {
  cwd: string;
  filePath: string;
  /** Initial content + mtime, typically fetched by the parent. */
  initialContent: string;
  initialMtime: number;
  initialSize: number;
  /**
   * Force read-only mode. Set for truncated files (the partial content
   * can't safely be saved — it would overwrite the tail of the file on
   * disk). Monaco's save action is disabled and the toolbar hides the
   * save button.
   */
  readOnly?: boolean;
  /** Optional banner text shown at the top (truncation hint, etc). */
  notice?: string | null;
  onClose(): void;
  onDirtyChange?(dirty: boolean): void;
  /** Surface save errors to the parent (toast, etc). Optional. */
  onError?(error: string): void;
}

export function MonacoEditor({
  cwd,
  filePath,
  initialContent,
  initialMtime,
  initialSize,
  readOnly = false,
  notice = null,
  onClose,
  onDirtyChange,
  onError,
}: MonacoEditorProps) {
  const mode = useTheme();
  const language = useMemo(() => langFor(filePath), [filePath]);
  const relPath = useMemo(
    () =>
      filePath.startsWith(cwd)
        ? filePath.slice(cwd.length).replace(/^\/+/, "")
        : filePath,
    [cwd, filePath],
  );

  const [content, setContent] = useState(initialContent);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [mtime, setMtime] = useState(initialMtime);
  const [size, setSize] = useState(initialSize);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<EditorConflict | null>(null);

  // Reset internal state when the parent hands us a new file. The parent
  // re-mounts the component on file switch via a `key={filePath}`, but
  // defensive re-init here keeps the component re-usable standalone.
  useEffect(() => {
    setContent(initialContent);
    setSavedContent(initialContent);
    setMtime(initialMtime);
    setSize(initialSize);
    setConflict(null);
  }, [initialContent, initialMtime, initialSize]);

  const isDirty = content !== savedContent;
  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const save = useCallback(
    async (overwrite = false) => {
      if (saving || readOnly) return false;
      setSaving(true);
      try {
        const body: Record<string, unknown> = {
          cwd,
          path: filePath,
          content,
        };
        if (!overwrite) body.expectedMtime = mtime;
        const res = await fetch("/api/files/write/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const respBody = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          mtime?: number;
          size?: number;
          error?: string;
          currentMtime?: number;
          detail?: string;
        };
        if (!res.ok) {
          if (res.status === 409 && respBody.error === "stale") {
            setConflict({
              currentMtime: respBody.currentMtime ?? 0,
              size: respBody.size ?? 0,
              onReload: () => {
                void reload();
                setConflict(null);
              },
              onOverwrite: async () => {
                setConflict(null);
                await save(true);
              },
            });
            return false;
          }
          onError?.(
            respBody.detail ?? respBody.error ?? `save failed (${res.status})`,
          );
          return false;
        }
        setSavedContent(content);
        setMtime(respBody.mtime ?? Date.now());
        setSize(respBody.size ?? new TextEncoder().encode(content).length);
        setConflict(null);
        return true;
      } finally {
        setSaving(false);
      }
    },
    [content, cwd, filePath, mtime, onError, readOnly, saving],
  );

  const reload = useCallback(async () => {
    const res = await fetch(
      `/api/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`,
    );
    if (!res.ok) return;
    const body = (await res.json()) as {
      content: string | null;
      size: number;
    };
    if (body.content == null) return;
    const now = Date.now();
    setContent(body.content);
    setSavedContent(body.content);
    setMtime(now);
    setSize(body.size);
  }, [cwd, filePath]);

  // `save` is a useCallback recreated on every `content` / `mtime`
  // change — but `editor.addAction` below captures whatever reference
  // exists at mount time. That stale closure held the initial
  // (empty-ish) content + the initial mtime forever; Cmd-S silently
  // wrote the unmodified original content back to disk, so the user
  // saw the dirty indicator stick and their edits never persist.
  //
  // Mirror the latest `save` into a ref on every render so the Monaco
  // action (which only runs from inside its `run`) always calls the
  // freshest closure. The toolbar's save button didn't have this bug
  // because its `onClick={() => void save()}` lambda is re-created
  // each render.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Capture the Monaco namespace on mount so the theme-sync effect
  // below can re-apply the theme when `mode` changes. Without this
  // the editor was painting with whichever theme existed at mount
  // time, ignoring later light/dark flips — user reported editor
  // surface staying bright in dark mode because `applyMonacoTheme`
  // only ran once in `handleMount`. Using the second arg of `OnMount`
  // as the source of truth for the type so we track @monaco-editor/react's
  // re-exports without reaching for `any`.
  type MonacoNamespace = Parameters<OnMount>[1];
  const monacoRef = useRef<MonacoNamespace | null>(null);

  const handleMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco;
    applyMonacoTheme(monaco, mode);
    if (!readOnly) {
      editor.addAction({
        id: "marvin.save",
        label: "Save",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => {
          void saveRef.current();
        },
      });
    }
  };

  // Re-apply Monaco's theme whenever the MARVIN theme flips. monaco's
  // `editor.setTheme` is a singleton — any editor instance globally
  // picks up the new theme — so this effect is enough to cover the
  // diff viewer too once it mounts.
  useEffect(() => {
    if (monacoRef.current) {
      applyMonacoTheme(monacoRef.current, mode);
    }
  }, [mode]);

  const lineCount = useMemo(
    () => (content === "" ? 0 : content.split("\n").length),
    [content],
  );

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/40">
      <EditorToolbar
        relPath={relPath}
        language={language}
        lineCount={lineCount}
        size={size}
        isDirty={isDirty}
        saving={saving}
        readOnly={readOnly}
        notice={notice}
        onSave={() => void save()}
        onClose={onClose}
        conflict={conflict}
      />
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          value={content}
          language={language}
          onMount={handleMount}
          onChange={(v) => setContent(v ?? "")}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbers: "on",
            renderWhitespace: "selection",
            wordWrap: "on",
            glyphMargin: false,
            folding: true,
            padding: { top: 8, bottom: 8 },
            automaticLayout: true,
            readOnly,
          }}
        />
      </div>
    </div>
  );
}
