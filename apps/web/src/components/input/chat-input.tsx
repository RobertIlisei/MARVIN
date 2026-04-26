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
  cancelling,
  disabled,
  hint,
  draft,
  draftKey,
}: {
  onSend: (text: string) => void;
  onCancel: () => void;
  busy: boolean;
  /** True while /api/chat/cancel is in flight — input stays disabled and
   *  stop button shows "stopping…". Audit finding #22. */
  cancelling?: boolean;
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

  // Re-apply the parent-supplied `draft` whenever the parent bumps
  // `draftKey`, even if the same string is sent again. Dropping
  // `setText` from the dep array is the right call here — it's a
  // stable React setter, not a value the effect should react to.
  // The audit-#26 nit asked us to either delete this disable or
  // explain it; here's the explanation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (draft != null) setText(draft);
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
              : cancelling
                ? "stopping…"
                : busy
                  ? "marvin is thinking — enter sends on next turn"
                  : "what are we building? (⏎ to send · ⇧⏎ for newline)"
          }
          disabled={disabled || busy || cancelling}
          // Audit finding #15: textarea previously had only a
          // placeholder. Screen readers fall back to whatever the
          // placeholder happens to be at announce-time — confusing
          // when it changes by state. Static aria-label is the cleaner
          // accessible name; the placeholder is still visible.
          aria-label="message to MARVIN"
          className="scroll-thin flex-1 resize-none rounded-lg border border-transparent bg-transparent px-3 py-2.5 text-[15px] leading-relaxed text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-border-strong)] disabled:opacity-50"
        />
        {busy ? (
          // Audit finding #28: stop is destructive — fill it. The
          // previous 10 % danger background read as a muted hint. A
          // filled danger button is the standard treatment for "this
          // cancels the running operation."
          //
          // Audit finding #22: while a /api/chat/cancel is in flight,
          // the button reads "stopping…" and is disabled. The whole
          // input stays disabled while cancelling so the user can't
          // start a new turn before the server has torn down the
          // previous one.
          <button
            type="button"
            onClick={cancelling ? undefined : onCancel}
            disabled={cancelling}
            title={cancelling ? "asking the server to stop…" : tooltip}
            aria-label={cancelling ? "stopping the current turn" : "stop the current turn"}
            className="shrink-0 rounded-lg border border-[color:var(--color-danger)] bg-[color:var(--color-danger)] px-4 py-2.5 text-xs font-semibold text-[color:var(--color-bg)] transition hover:opacity-90 disabled:cursor-progress disabled:opacity-60"
          >
            {cancelling ? "stopping…" : "stop"}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            title={tooltip}
            aria-label="send message"
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
