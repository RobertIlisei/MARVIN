"use client";

/**
 * Inline rename: replaces the label of a tree row with a focused text
 * input. Keys:
 *
 *   Enter  → commit (call `onCommit(newName)`; parent decides whether to
 *            persist or bail on same-value)
 *   Esc    → cancel (call `onCancel()`)
 *   Tab    → treated as commit for now (Esc-to-cancel is the explicit
 *            affordance; Tab should not drop the edit silently)
 *
 * Does NOT talk to the API itself — the wrapper decides how to map a new
 * basename to the full-path rename call.
 */

import { useEffect, useRef, useState } from "react";

export function InlineRename({
  initial,
  onCommit,
  onCancel,
  paddingLeft,
  selectExtension = false,
}: {
  initial: string;
  onCommit(newName: string): void;
  onCancel(): void;
  paddingLeft: number;
  /** If false (default), select only the stem before the last `.`. */
  selectExtension?: boolean;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (!selectExtension && dot > 0) {
      el.setSelectionRange(0, dot);
    } else {
      el.select();
    }
  }, [initial, selectExtension]);

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const trimmed = value.trim();
          if (trimmed.length === 0 || trimmed === initial) {
            onCancel();
            return;
          }
          onCommit(trimmed);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        // Commit on blur if the user typed something new; otherwise silently
        // cancel. Matches Finder behaviour.
        const trimmed = value.trim();
        if (trimmed.length > 0 && trimmed !== initial) onCommit(trimmed);
        else onCancel();
      }}
      className="h-[20px] flex-1 rounded border border-[color:var(--color-accent)]/40 bg-[color:var(--color-bg)] px-1 font-mono text-[12px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-accent)]"
      style={{ marginLeft: paddingLeft }}
      spellCheck={false}
      autoComplete="off"
    />
  );
}
