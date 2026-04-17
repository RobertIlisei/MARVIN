"use client";

import { useEffect, useState } from "react";

type ContentResponse = {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
  maxSize?: number;
};

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
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
  kt: "kotlin",
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
  env: "env",
};

function langForPath(p: string): string {
  const name = p.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return LANG_BY_EXT[ext] ?? "text";
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function FileViewer({
  cwd,
  filePath,
  onClose,
}: {
  cwd: string;
  filePath: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ContentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    fetch(
      `/api/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`,
    )
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? r.statusText);
        }
        return (await r.json()) as ContentResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, filePath]);

  const relPath = filePath.startsWith(cwd)
    ? filePath.slice(cwd.length).replace(/^\/+/, "")
    : filePath;
  const lang = langForPath(filePath);
  const lineCount = data?.content ? data.content.split("\n").length : 0;

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/40">
      <div className="flex items-center gap-3 border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-[11px]">
        <span className="text-[color:var(--color-fg-faint)]">file</span>
        <span className="truncate text-[color:var(--color-fg)]">{relPath}</span>
        <span className="ml-auto flex items-center gap-3 text-[color:var(--color-fg-faint)]">
          {data && !data.binary && (
            <>
              <span>{lang}</span>
              <span>·</span>
              <span>{lineCount} lines</span>
              <span>·</span>
              <span>{fmtBytes(data.size)}</span>
            </>
          )}
          {data?.binary && <span>binary · {fmtBytes(data.size)}</span>}
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
            aria-label="close file"
          >
            close ✕
          </button>
        </span>
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-auto">
        {loading && !data && (
          <div className="p-4 text-xs text-[color:var(--color-fg-dim)]">
            reading file…
          </div>
        )}
        {error && (
          <div className="p-4 text-xs text-[color:var(--color-danger)]/80">
            {error}
          </div>
        )}
        {data?.truncated && (
          <div className="border-b border-[color:var(--color-border)] bg-[color:var(--color-warn)]/10 px-3 py-2 text-[11px] text-[color:var(--color-warn)]">
            file is larger than {fmtBytes(data.maxSize ?? 0)} — not loaded.
          </div>
        )}
        {data?.binary && (
          <div className="p-4 text-xs text-[color:var(--color-fg-dim)]">
            binary file — preview not available.
          </div>
        )}
        {data?.content != null && <CodeBlock content={data.content} />}
      </div>
    </div>
  );
}

function CodeBlock({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <pre className="m-0 flex font-mono text-[12px] leading-[1.55]">
      <div
        aria-hidden
        className="sticky left-0 select-none border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 px-2 py-3 text-right text-[color:var(--color-fg-faint)]"
      >
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <code className="block flex-1 whitespace-pre px-3 py-3 text-[color:var(--color-fg)]/92">
        {content}
      </code>
    </pre>
  );
}
