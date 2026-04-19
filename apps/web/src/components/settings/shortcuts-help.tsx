"use client";

interface Shortcut {
  keys: string;
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "⌘ K", description: "Open the project picker" },
  { keys: "⌘ ⇧ N", description: "Start a new session" },
  { keys: "⌘ B", description: "Toggle the files pane" },
  { keys: "⌘ G", description: "Toggle the graph pane" },
  { keys: "⌘ J", description: "Toggle the embedded terminal" },
  { keys: "⌘ P", description: "Toggle the browser preview pane" },
  { keys: "⌘ .", description: "Cancel the current turn" },
  { keys: "⏎", description: "Send message (in chat input)" },
  { keys: "⇧ ⏎", description: "Newline (in chat input)" },
  { keys: "?", description: "Show / hide this help" },
  { keys: "Esc", description: "Close dialogs" },
];

export function ShortcutsHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="glass w-[min(480px,calc(100vw-2rem))] rounded-2xl p-5">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-mono text-sm font-medium tracking-[0.18em] text-[color:var(--color-fg)]">
            keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-[color:var(--color-fg-faint)] transition hover:text-[color:var(--color-fg)]"
          >
            close ✕
          </button>
        </div>
        <ul className="divide-y divide-[color:var(--color-border)]/60">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys}
              className="flex items-center justify-between gap-4 py-1.5"
            >
              <kbd className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 px-2 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)]">
                {s.keys}
              </kbd>
              <span className="flex-1 text-right text-[12px] text-[color:var(--color-fg-dim)]">
                {s.description}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 font-mono text-[10px] text-[color:var(--color-fg-faint)]">
          On macOS ⌘ is Cmd; on Linux / Windows substitute Ctrl.
        </p>
      </div>
    </div>
  );
}
