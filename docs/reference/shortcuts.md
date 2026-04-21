# Keyboard shortcuts

All shortcuts registered via a single `window` keydown listener in [`page.tsx`](../../../apps/web/src/app/page.tsx). An `isEditable` guard skips them when focus is inside an input, textarea, or contentEditable element, so they don't swallow keys while typing.

Press `?` in the app to see the live overlay (source: [`shortcuts-help.tsx`](../../../apps/web/src/components/settings/shortcuts-help.tsx)).

## Global

| Keys | Action |
|---|---|
| `⌘ K` / `Ctrl K` | Open the project picker |
| `⌘ ⇧ N` / `Ctrl ⇧ N` | Start a new session (clears the current messages, returns to hero) |
| `⌘ .` / `Ctrl .` | Cancel the currently-running turn |
| `?` | Toggle the shortcuts overlay |
| `Esc` | Close any open dialog (picker, shortcuts, model picker, add-project) |

## Panes

| Keys | Action |
|---|---|
| `⌘ B` / `Ctrl B` | Toggle the file tree pane |
| `⌘ G` / `Ctrl G` | Toggle the knowledge graph pane |
| `⌘ J` / `Ctrl J` | Toggle the embedded terminal |
| `⌘ P` / `Ctrl P` | Toggle the browser preview pane |

All pane states persist to `localStorage` via `react-resizable-panels`' `autoSaveId`.

## Chat input

| Keys | Action |
|---|---|
| `⏎` | Send message |
| `⇧ ⏎` | Newline in the input (no send) |
| `⌘ ⏎` | Also sends (parity for Mac-intuitive users) |

## File tree

Right-click any row to open the context menu. Gestures below work on the tree as a whole when it has focus.

| Keys / gesture | Action |
|---|---|
| `⌘ ⌫` / `Ctrl ⌫` | Move selected item(s) to Trash |
| `⌘ ⇧ ⌫` / `Ctrl ⇧ ⌫` | Delete selected item(s) permanently (confirm required) |
| `F2` | Rename the currently-selected item (inline input; `Enter` commits, `Esc` cancels) |
| `Shift-click` | Range-select from the last anchor to the clicked row |
| `⌘-click` / `Ctrl-click` | Toggle individual rows in/out of the selection |
| `Esc` | Clear the selection |
| Drag a file/dir onto a directory | Move the dragged item(s) into that directory |

Destructive ops classified as `confirm` (permanent delete, secret-file writes, case-only renames) surface an AlertDialog. The user-initiated write channel is gated by `fsWritePolicy` — see [tool-policy](../security/tool-policy.md) and [ADR-0008](../decisions/0008-user-initiated-write-channel.md).

## Terminal (focus inside the xterm pane)

| Keys | Action |
|---|---|
| `↑` / `↓` | Walk command history |
| `Ctrl C` | Cancel the running command (or clear the current line if idle) |
| `Ctrl L` | Clear the screen, preserve the current line buffer |

History persists to `localStorage.marvin.term.history`, capped at 100 entries.

## Wordmark click

The `marvin` wordmark in the top-left header is a button:

- **Hero state** (no messages): no-op (disabled).
- **Shell state** (messages present): clicking returns to the hero, equivalent to `⌘⇧N` / "new session."

Added as a conventional logo-as-home affordance after users reported the "new session" button on the right of the header was easy to miss.

## Notes

- On Linux and Windows, substitute `Ctrl` for `⌘` everywhere.
- `Cmd-P` overrides the browser's "print" shortcut only when MARVIN's tab has focus. If you want to print the MARVIN UI (why?), use the browser menu.
- Shortcuts do not fire inside Monaco diff editors or the embedded terminal — those have their own focus handling.

## Related

- [`page.tsx` keyboard section](../../../apps/web/src/app/page.tsx) — the keydown handler.
- [Shortcuts overlay component](../../../apps/web/src/components/settings/shortcuts-help.tsx) — the in-app help.
