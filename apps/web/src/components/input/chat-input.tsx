"use client";

import { useEffect, useRef, useState } from "react";

export function ChatInput({
  cwd,
  onCwdChange,
  onSend,
  onCancel,
  busy,
  disabled,
}: {
  cwd: string;
  onCwdChange: (cwd: string) => void;
  onSend: (text: string) => void;
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea with content, up to a ceiling.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled) return;
    onSend(trimmed);
    setText("");
  };

  return (
    <div className="glass rounded-2xl p-3">
      <div className="flex items-center gap-2 pb-2 text-[11px] text-[color:var(--color-fg-dim)]">
        <span className="font-mono text-[10px] uppercase tracking-[0.25em]">project</span>
        <input
          type="text"
          value={cwd}
          onChange={(e) => onCwdChange(e.target.value)}
          placeholder="/path/to/your/project"
          className="flex-1 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-1 font-mono text-[12px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent-deep)]/50"
        />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={
            disabled
              ? "pick a project directory first"
              : busy
                ? "marvin is thinking — enter sends on next turn"
                : "what are we building? (⏎ to send · ⇧⏎ for newline)"
          }
          disabled={disabled}
          className="scroll-thin flex-1 resize-none rounded-lg border border-transparent bg-transparent px-2 py-2 text-sm leading-relaxed text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-border-strong)] disabled:opacity-50"
        />
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-danger)]/10 px-3 py-2 text-xs text-[color:var(--color-danger)] transition hover:border-[color:var(--color-danger)]/30"
          >
            stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || disabled}
            className="shrink-0 rounded-lg border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] px-4 py-2 text-xs font-medium text-[color:var(--color-accent)] transition hover:border-[color:var(--color-accent-deep)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            send ⏎
          </button>
        )}
      </div>
    </div>
  );
}
