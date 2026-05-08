"use client";

import { useEffect, useRef, useState } from "react";

import type { VerifyResult } from "./types";

export function AddProjectDialog({
  open,
  initialPath = "",
  onClose,
  onSubmit,
  verifyWorkDir,
}: {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    workDir: string;
    setActive: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  verifyWorkDir: (path: string) => Promise<VerifyResult>;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState(initialPath);
  const [setActive, setSetActive] = useState(true);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPath(initialPath);
      setName("");
      setVerify(null);
      setError(null);
      setTimeout(() => pathRef.current?.focus(), 30);
    }
  }, [open, initialPath]);

  // Debounced auto-verify when the path changes.
  useEffect(() => {
    if (!open) return;
    const trimmed = path.trim();
    if (!trimmed) {
      setVerify(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const result = await verifyWorkDir(trimmed);
        setVerify(result);
        if (result.ok && !name) {
          const base = result.absolutePath.split("/").filter(Boolean).pop();
          if (base) setName(base);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 280);
    return () => clearTimeout(t);
  }, [path, open, verifyWorkDir, name]);

  if (!open) return null;

  const canSubmit = !!verify?.ok && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await onSubmit({
        name: name.trim() || (verify?.absolutePath.split("/").pop() ?? ""),
        workDir: verify!.absolutePath,
        setActive,
      });
      if (res.ok) onClose();
      else setError(res.error ?? "Failed to add project");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--color-bg-glass)] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass w-[min(560px,calc(100vw-2rem))] rounded-2xl p-5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-mono text-sm font-medium tracking-[0.18em] text-[color:var(--color-fg)]">
            add project
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-mono text-[color:var(--color-fg-faint)] transition hover:text-[color:var(--color-fg)]"
          >
            close ✕
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.25em] text-[color:var(--color-fg-dim)]">
              absolute path
            </span>
            <input
              ref={pathRef}
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="/Users/you/code/my-app"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-2 font-mono text-xs text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent-deep)]/50"
            />
            {verify && (
              <div
                className={`mt-1 font-mono text-[11px] ${
                  verify.ok
                    ? "text-[color:var(--color-accent)]"
                    : "text-[color:var(--color-danger)]"
                }`}
              >
                {verify.ok
                  ? `✓ ${verify.absolutePath}`
                  : `✗ ${verify.error ?? "Invalid path"}`}
              </div>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.25em] text-[color:var(--color-fg-dim)]">
              display name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="auto — derived from path"
              className="w-full rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-2 text-sm text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent-deep)]/50"
            />
          </label>

          <label className="flex items-center gap-2 text-[12px] text-[color:var(--color-fg-dim)]">
            <input
              type="checkbox"
              checked={setActive}
              onChange={(e) => setSetActive(e.target.checked)}
              className="accent-[color:var(--color-accent)]"
            />
            switch to this project after adding
          </label>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10 px-3 py-2 text-[11px] text-[color:var(--color-danger)]">
            {error}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[color:var(--color-border)] px-3 py-1.5 text-xs text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
          >
            cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="rounded-lg border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] px-4 py-1.5 text-xs font-medium text-[color:var(--color-accent)] transition hover:border-[color:var(--color-accent-deep)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "adding…" : "add project"}
          </button>
        </div>
      </div>
    </div>
  );
}
