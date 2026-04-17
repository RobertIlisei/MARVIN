"use client";

import { useState } from "react";

import { DiffViewer } from "@/components/diff/diff-viewer";

type EditInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
};

type WriteInput = {
  file_path?: string;
  content?: string;
};

export function ConfirmPrompt({
  toolName,
  input,
  reason,
  title,
  description,
  onAllow,
  onDeny,
  decided,
}: {
  toolName: string;
  input: unknown;
  reason: string;
  title?: string;
  description?: string;
  onAllow: () => Promise<void> | void;
  onDeny: (message?: string) => Promise<void> | void;
  decided?: "allow" | "deny";
}) {
  const [busy, setBusy] = useState(false);
  const [denyNote, setDenyNote] = useState("");
  const [showDeny, setShowDeny] = useState(false);

  const allow = async () => {
    setBusy(true);
    try {
      await onAllow();
    } finally {
      setBusy(false);
    }
  };
  const deny = async () => {
    setBusy(true);
    try {
      await onDeny(denyNote.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };

  const editInput = toolName === "Edit" ? (input as EditInput) : null;
  const writeInput = toolName === "Write" ? (input as WriteInput) : null;
  const bashCommand =
    toolName === "Bash" && typeof input === "object" && input !== null
      ? String((input as { command?: unknown }).command ?? "")
      : null;

  return (
    <div className="rise-in my-2 overflow-hidden rounded-lg border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)]/40 text-xs">
      <div className="flex items-center gap-2 border-b border-[color:var(--color-accent-deep)]/25 px-3 py-2 font-mono">
        <span className="flex h-5 w-5 items-center justify-center rounded-md border border-[color:var(--color-accent-deep)]/40 text-[color:var(--color-accent)]">
          ⏸
        </span>
        <span className="text-[color:var(--color-fg)]">
          {title ?? `MARVIN wants to use ${toolName}`}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-widest text-[color:var(--color-accent)]">
          awaiting confirm
        </span>
      </div>
      <div className="px-3 py-3 font-mono text-[11px] text-[color:var(--color-fg)]/90">
        {description && (
          <div className="mb-2 text-[color:var(--color-fg-dim)]">{description}</div>
        )}
        {reason && (
          <div className="mb-2 text-[color:var(--color-fg-faint)]">reason: {reason}</div>
        )}

        {editInput && (
          <>
            <div className="mb-1 text-[color:var(--color-fg-dim)]">
              {editInput.file_path ?? "file"}
            </div>
            <DiffViewer
              filePath={editInput.file_path ?? "untitled"}
              original={editInput.old_string ?? ""}
              modified={editInput.new_string ?? ""}
              maxHeight={320}
            />
          </>
        )}
        {writeInput && (
          <>
            <div className="mb-1 text-[color:var(--color-fg-dim)]">
              new file: {writeInput.file_path ?? "untitled"}
            </div>
            <DiffViewer
              filePath={writeInput.file_path ?? "untitled"}
              original=""
              modified={writeInput.content ?? ""}
              maxHeight={320}
            />
          </>
        )}
        {bashCommand != null && (
          <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)] p-2 text-[color:var(--color-fg)]/90">
            $ {bashCommand}
          </pre>
        )}
        {!editInput && !writeInput && bashCommand == null && (
          <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)] p-2 text-[color:var(--color-fg)]/80">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {decided ? (
          <div
            className={`mt-3 text-[10px] uppercase tracking-widest ${decided === "allow" ? "text-[color:var(--color-success)]" : "text-[color:var(--color-danger)]"}`}
          >
            {decided === "allow" ? "allowed" : "denied"}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={allow}
              disabled={busy}
              className="rounded-md border border-[color:var(--color-success)]/40 bg-[color:var(--color-success)]/10 px-3 py-1 text-[color:var(--color-success)] transition hover:border-[color:var(--color-success)]/70 disabled:opacity-40"
            >
              allow
            </button>
            {!showDeny ? (
              <button
                type="button"
                onClick={() => setShowDeny(true)}
                disabled={busy}
                className="rounded-md border border-[color:var(--color-danger)]/40 px-3 py-1 text-[color:var(--color-danger)] transition hover:border-[color:var(--color-danger)]/70 disabled:opacity-40"
              >
                deny
              </button>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="text"
                  value={denyNote}
                  onChange={(e) => setDenyNote(e.target.value)}
                  placeholder="optional note for MARVIN"
                  className="flex-1 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-[11px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-danger)]/50"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={deny}
                  disabled={busy}
                  className="rounded-md border border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10 px-2.5 py-1 text-[color:var(--color-danger)] transition hover:border-[color:var(--color-danger)]/70 disabled:opacity-40"
                >
                  send deny
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDeny(false);
                    setDenyNote("");
                  }}
                  disabled={busy}
                  className="text-[color:var(--color-fg-faint)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
                  aria-label="cancel"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
