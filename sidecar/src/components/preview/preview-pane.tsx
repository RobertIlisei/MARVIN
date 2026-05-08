"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const LS_PREVIEW_URL_PREFIX = "marvin.previewUrl.";

/**
 * Live browser preview pane. Loads an iframe at a user-supplied URL, which
 * is persisted per-project in localStorage. Most local dev servers allow
 * framing — when one doesn't (X-Frame-Options / CSP frame-ancestors), the
 * fallback overlay offers "open in new tab".
 */
const FRAME_LOAD_TIMEOUT_MS = 15_000;

export function PreviewPane({ projectId }: { projectId: string | null }) {
  const storageKey = projectId ? `${LS_PREVIEW_URL_PREFIX}${projectId}` : null;
  const [url, setUrl] = useState<string>("");
  const [pendingUrl, setPendingUrl] = useState<string>("");
  const [reloadKey, setReloadKey] = useState(0);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [loadStalled, setLoadStalled] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Hydrate persisted URL when the active project changes.
  useEffect(() => {
    setFrameLoaded(false);
    setLoadStalled(false);
    if (!storageKey) {
      setUrl("");
      setPendingUrl("");
      return;
    }
    try {
      const saved = localStorage.getItem(storageKey) ?? "";
      setUrl(saved);
      setPendingUrl(saved);
    } catch {
      setUrl("");
      setPendingUrl("");
    }
  }, [storageKey]);

  // If onLoad never fires (blocked by X-Frame-Options / CSP, offline target),
  // surface a stalled state after the timeout instead of spinning forever.
  useEffect(() => {
    if (!url || frameLoaded) return;
    const timer = window.setTimeout(
      () => setLoadStalled(true),
      FRAME_LOAD_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [url, reloadKey, frameLoaded]);

  const apply = () => {
    const next = pendingUrl.trim();
    if (!next) return;
    setUrl(next);
    setFrameLoaded(false);
    setLoadStalled(false);
    setReloadKey((v) => v + 1);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        /* no storage */
      }
    }
  };

  const refresh = () => {
    if (!url) return;
    setFrameLoaded(false);
    setLoadStalled(false);
    setReloadKey((v) => v + 1);
  };

  const openExternal = () => {
    if (!url) return;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const placeholder = useMemo(
    () => (projectId ? "http://localhost:3000" : "pick a project first"),
    [projectId],
  );

  const frameKey = `${url}#${reloadKey}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[color:var(--color-border)] px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
          preview
        </span>
        <input
          value={pendingUrl}
          onChange={(e) => setPendingUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          placeholder={placeholder}
          spellCheck={false}
          disabled={!projectId}
          className="flex-1 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-accent-deep)]/50 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={apply}
          disabled={!pendingUrl.trim() || !projectId}
          title="load URL  (⏎)"
          className="rounded-md border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--color-accent)] transition hover:border-[color:var(--color-accent-deep)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          load
        </button>
        <button
          type="button"
          onClick={refresh}
          disabled={!url}
          aria-label="refresh preview"
          title="refresh"
          className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[10px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={openExternal}
          disabled={!url}
          aria-label="open preview in a new tab"
          title="open in a new tab"
          className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[10px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ↗
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-[color:var(--color-bg-elev)]/20">
        {!url ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-[color:var(--color-fg-dim)]">
            Enter a URL above (usually a local dev server like
            <br />
            <span className="font-mono text-[color:var(--color-fg)]">
              http://localhost:3000
            </span>
            ).
          </div>
        ) : (
          <>
            <iframe
              key={frameKey}
              ref={iframeRef}
              src={url}
              title="project preview"
              onLoad={() => setFrameLoaded(true)}
              sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
              // No explicit background — the previewed page paints its own.
              // Forcing `bg-white` made the iframe chrome clash with the
              // dark-theme canvas while the page loaded.
              className="h-full w-full border-0 bg-transparent"
            />
            {!frameLoaded && !loadStalled && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[11px] text-[color:var(--color-fg-faint)]">
                loading {url}…
              </div>
            )}
            {!frameLoaded && loadStalled && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center font-mono text-[11px] text-[color:var(--color-warn)]">
                <span>still loading {url}…</span>
                <span className="text-[10px] text-[color:var(--color-fg-faint)]">
                  the page may be blocking frames (X-Frame-Options / CSP). Try ↻ or ↗.
                </span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="border-t border-[color:var(--color-border)] px-3 py-1.5 font-mono text-[10px] text-[color:var(--color-fg-faint)]">
        {url ? (
          <>
            <span className="text-[color:var(--color-fg-dim)]">src:</span>{" "}
            {url}
            <span className="ml-2 text-[color:var(--color-fg-faint)]">
              — if the page refuses to frame (X-Frame-Options / CSP), use ↗
              to open externally.
            </span>
          </>
        ) : (
          "nothing loaded"
        )}
      </div>
    </div>
  );
}
