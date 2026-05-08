# Keyboard shortcuts

The macOS app's shortcut surface, sourced from the SwiftUI `commands` block in [`MARVINApp.swift`](../../macos/MARVIN/MARVINApp.swift) plus per-view bindings (`.keyboardShortcut(...)`). Run `Window → Keyboard Shortcuts…` (`⌘/`) inside the app for the live overlay.

## Global (always available)

Wired in [`MARVINApp.swift`](../../macos/MARVIN/MARVINApp.swift) via `CommandGroup` and `WindowGroup.commands { ... }`.

| Keys | Action | Source |
|---|---|---|
| `⌘ O` | Open Project — NSOpenPanel; registers + activates the chosen `workDir` | File menu |
| `⌘ ⌥ R` | Reveal active project in Finder | File menu |
| `⌘ ⌥ T` | Open Terminal at the active project's `workDir` | File menu |
| `⌘ /` | Open the **Keyboard Shortcuts** sheet (this list, native) | Window menu |
| `⌘ P` | Quick Open File — fuzzy across the active project's tree | Window menu |
| `⌘ T` | Go to Symbol — fuzzy across the project's `graphify-out/graph.json` | Window menu |
| `⌘ ⇧ B` | Run Build Task — discovers tasks from `package.json` / `Makefile` / `Package.swift` / `Cargo.toml` and injects the chosen command into the terminal | Window menu |
| `⌘ ⇧ T` | Toggle theme (light / dark) | Window menu |

## Chat

| Keys | Action | Source |
|---|---|---|
| `⏎` | Send message | `ChatInputView` |
| `⌘ .` | Cancel the currently-running turn | `ChatInputView` |
| `⌘ ⇧ A` | Add attachment | `ChatAttachments` |

## File viewer (when an editor pane is focused)

| Keys | Action |
|---|---|
| `⌘ S` | Save the current file (CAS on mtime — banner surfaces if the file changed on disk). Refuses to mount on binary or >512 KB truncated files. |
| `⌘ W` | Close the active file pane |

## File tree (when the tree row has focus)

| Keys / gesture | Action |
|---|---|
| `Return` | Open the focused row in the centre viewer |
| `Space` | Primary action for the row's bucket — stage (Changes / Untracked) or unstage (Staged); no-op in Conflicts |
| `⌘ ⌫` | Move selected item(s) to Trash |
| Drag onto a directory | Move the dragged item(s) into that directory |

Destructive operations classified `confirm` (permanent delete, secret-file writes, case-only renames) surface a confirm sheet — see [tool-policy](../security/tool-policy.md) and [ADR-0008](../decisions/0008-user-initiated-write-channel.md).

## Source control (when the status list has focus)

| Keys | Action |
|---|---|
| `⌘ Return` | Commit (or amend, when the amend checkbox is on) |
| `Space` | Primary action for the focused row's bucket — stage / unstage |
| `Return` | Open the focused file in the centre viewer |

## Terminal (when the terminal pane is focused)

| Keys | Action |
|---|---|
| `⌘ K` | Clear scrollback |
| `Ctrl C` | Cancel the running command (or clear the current line if idle) — handled by xterm |
| `Ctrl L` | Clear the screen, preserve the current line buffer — handled by xterm |
| `↑` / `↓` | Walk command history (capped at 100 entries) |

## Chat preview (when the standalone preview window is focused)

| Keys | Action |
|---|---|
| `⌘ ⇧ N` | Reset the preview state — wipes the message list and cancels any in-flight turn (`ChatPreviewModel.clear()`) |

## Sheets and dialogs

Every native sheet (`ConfirmSheet`, `GitConfirmSheet`, `DiffSheet`, `ChatAttachments` picker, `FileTreeView` rename / delete, `TopBarPopovers`, `ShortcutsHelpSheet`) wires the standard SwiftUI conventions:

| Keys | Action |
|---|---|
| `Esc` | Cancel / dismiss |
| `Return` | Default action (allow, save, commit, …) |

## Offline view

| Keys | Action |
|---|---|
| `⌘ R` | Reconnect — re-runs `/api/health` against the sidecar |

## Known gaps (vs the pre-migration web shell)

Surfaces that the old Next.js shell exposed via React keyboard handlers and that the SwiftUI app does not yet bind globally:

- **`⌘ K` — Project Picker.** Project switching today goes through `⌘ O` (Open Project) or the `Open Recent` menu. A global `⌘ K` binding would re-introduce the picker shortcut MARVIN users had pre-Swift-migration.
- **`⌘ ⇧ N` — Global "New Session".** Wired as a `File → New Session` menu item, but the action is a placeholder pending a formalised cross-window session-reset path. The chat preview window has its own `⌘ ⇧ N` (reset preview only).
- **`⌘ B` / `⌘ G` / `⌘ J` / `⌘ ⇧ P` — pane toggles** (file tree, knowledge graph, terminal, browser preview). Panes are toggled today via the toolbar; no global keyboard bindings.
- **`?` — overlay toggle.** Replaced by `⌘ /` (Window → Keyboard Shortcuts). The plain-key form fires inside text inputs, which makes it awkward in a native app; the modifier form is a deliberate shift.
- **`F2` — rename selected.** File-tree rename is currently triggered from the context menu / a dedicated rename sheet rather than a keyboard binding.

These are tracked as follow-ups to the SwiftUI migration; none are SwiftUI limitations, only un-wired affordances.

## Related

- [`MARVINApp.swift`](../../macos/MARVIN/MARVINApp.swift) — `commands` block, the source of truth for menu-bar shortcuts.
- [Native `ShortcutsHelpSheet`](../../macos/MARVIN/ShortcutsHelpSheet.swift) — the sheet that opens via `⌘/`.
