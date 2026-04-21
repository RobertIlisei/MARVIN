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

function langFor(p: string): string {
  const name = p.split("/").pop() ?? "";
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

  const handleMount: OnMount = (editor, monaco) => {
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
