"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Pure chat input. Project selection now lives in the top-level
 * `<ProjectPicker />`; this component just handles the textarea, send, and
 * cancel. Parent passes `disabled` when no project is active so we can
 * render a clear hint.
 */
export function ChatInput({
  onSend,
  onCancel,
  busy,
  disabled,
  hint,
  draft,
  draftKey,
}: {
  onSend: (text: string) => void;
  onCancel: () => void;
  busy: boolean;
  disabled?: boolean;
  /** Short message shown below the input explaining why it's disabled, if so. */
  hint?: string;
  /** Optional external draft to prefill the textarea with. */
  draft?: string;
  /** Bump this to force the draft to re-apply even with identical text. */
  draftKey?: number;
}) {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft != null) setText(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, draftKey]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => {
    if (!disabled && !busy) taRef.current?.focus();
  }, [disabled, busy]);

  const canSend = !disabled && !busy && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText("");
  };

  const tooltip = useMemo(() => {
    if (busy) return "cancel the current turn";
    if (disabled) return hint ?? "disabled";
    if (!text.trim()) return "type a message";
    return "send message (⏎)";
  }, [busy, disabled, text, hint]);

  return (
    <div className="glass rounded-2xl p-3">
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
              ? (hint ?? "pick a project first")
              : busy
                ? "marvin is thinking — enter sends on next turn"
                : "what are we building? (⏎ to send · ⇧⏎ for newline)"
          }
          disabled={disabled || busy}
          className="scroll-thin flex-1 resize-none rounded-lg border border-transparent bg-transparent px-3 py-2.5 text-[15px] leading-relaxed text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-border-strong)] disabled:opacity-50"
        />
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            title={tooltip}
            className="shrink-0 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-danger)]/10 px-4 py-2.5 text-xs text-[color:var(--color-danger)] transition hover:border-[color:var(--color-danger)]/30"
          >
            stop
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            title={tooltip}
            className="shrink-0 rounded-lg border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] px-5 py-2.5 text-sm font-medium text-[color:var(--color-accent)] transition hover:border-[color:var(--color-accent-deep)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            send ⏎
          </button>
        )}
      </div>
      {disabled && hint && (
        <div className="mt-1 px-1 font-mono text-[10px] text-[color:var(--color-fg-faint)]">
          {hint}
        </div>
      )}
    </div>
  );
}
