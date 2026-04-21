"use client";

/**
 * Commit message textarea + amend toggle + commit button.
 *
 * Keyboard: `⌘Enter` / `Ctrl+Enter` while the textarea is focused
 * fires commit. `Esc` exits amend mode.
 *
 * Commit button is enabled when:
 *   - message is non-empty (or amend is on without a new message),
 *   - at least one file is staged (or amend — amending can succeed
 *     with nothing new staged).
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface CommitBoxProps {
  stagedCount: number;
  busy: boolean;
  onCommit(message: string, amend: boolean): Promise<boolean>;
}

export function CommitBox({ stagedCount, busy, onCommit }: CommitBoxProps) {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const canCommit =
    !busy && (stagedCount > 0 || amend) && (message.trim().length > 0 || amend);

  const handleCommit = useCallback(async () => {
    if (!canCommit) return;
    const ok = await onCommit(message, amend);
    if (ok) {
      setMessage("");
      setAmend(false);
    }
  }, [canCommit, message, amend, onCommit]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Auto-grow: 1..6 lines. Avoids a fixed-height box that's too
    // cramped for multi-line messages without going full textarea
    // sprawl.
    ta.style.height = "auto";
    const next = Math.min(ta.scrollHeight, 14 * 7);
    ta.style.height = `${Math.max(34, next)}px`;
  }, [message]);

  return (
    <div className="border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/30 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
        <span>{amend ? "amend last commit" : "commit"}</span>
        <span className="tracking-normal">
          {stagedCount === 0
            ? amend
              ? "no staged changes — message only"
              : "nothing staged"
            : `${stagedCount} file${stagedCount === 1 ? "" : "s"} staged`}
        </span>
      </div>
      <textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void handleCommit();
          } else if (e.key === "Escape" && amend) {
            e.preventDefault();
            setAmend(false);
          }
        }}
        placeholder={amend ? "new message — empty to keep existing" : "commit message"}
        rows={1}
        spellCheck
        className="scroll-thin w-full resize-none rounded-[4px] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-[color:var(--color-fg)] placeholder:text-[color:var(--color-fg-faint)] focus:border-[color:var(--color-accent-deep)] focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-[10.5px] text-[color:var(--color-fg-dim)] select-none">
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => setAmend(e.target.checked)}
            className="size-3.5"
          />
          amend
        </label>
        <button
          type="button"
          disabled={!canCommit}
          onClick={() => void handleCommit()}
          className={`rounded-[4px] px-3 py-1 font-mono text-[11px] font-medium transition ${
            canCommit
              ? "bg-[color:var(--color-accent-deep)] text-[color:var(--color-bg)] hover:bg-[color:var(--color-accent-deep)]/85"
              : "cursor-not-allowed bg-[color:var(--color-bg-elev)] text-[color:var(--color-fg-faint)]"
          }`}
          title="⌘⏎ · commit"
        >
          {busy ? "…" : amend ? "amend" : "commit"}
        </button>
      </div>
    </div>
  );
}
