# IDE parity — Antigravity's menu bar vs MARVIN

Audited 2026-08-31 against screenshots of Antigravity IDE's full menu bar
(File / Edit / Selection / View / Go / Run / Terminal / Window / Help) plus
its Settings pane. Antigravity is a VS Code fork, so this doubles as a VS
Code and Cursor comparison.

**How to read the status column.** ✅ shipped · 🟡 partial · ⬜ not started ·
🚫 not applicable to MARVIN (with the reason). "Needs LSP" means the
capability arrives over the language-server connection added in
[ADR-0099](../decisions/0099-lsp-client-for-live-diagnostics.md) and is a
UI question now rather than an architecture one. "Needs DAP" means it needs
a Debug Adapter Protocol client, which MARVIN does not have and which would
need its own ADR.

---

## File

| Item | Status | Note |
|---|---|---|
| New Text File | ✅ | ⌘N. Opens the file tree's own naming sheet at the project root — a real path rather than an untitled buffer, which is what the buffer model supports. |
| New File… | 🟡 | The file tree can create files; there is no menu entry. |
| New Window | 🚫 | MARVIN is single-window by design (ADR-0021). Multiple projects = multiple sessions, not multiple windows. |
| New Window with Profile | 🚫 | No profile concept. |
| Open… / Open Folder… | ✅ | `⌘O`, registry `file.openProject`. |
| Open Workspace from File… | 🚫 | No multi-root workspace concept. |
| Open Recent ▸ | ✅ | File menu submenu, bridge-populated. |
| Add Folder to Workspace… | 🚫 | Single-root by design (Golden Rule 4). |
| Save / Save As… | 🟡 | `⌘S` saves the active editor. No Save As. |
| Save All | ✅ | ⌥⌘S. Sequential, not concurrent — each save round-trips an `mtime`, and parallel writes would make the stale-conflict alert ambiguous. |
| Auto Save | ✅ | Off by default; 1.5 s debounce after the last keystroke, through the same `mtime`-guarded save path, so a stale write still raises the conflict alert. |
| Revert File | ✅ | Confirmation-gated — the one command in the group with no undo. |
| Close Editor | ✅ | `⌘W`. |
| Close All Editors | ✅ | New — registry `file.closeAllEditors`. |
| Reveal in Finder | ✅ | `⌥⌘R`. |
| Copy Path of Active File | ✅ | New — registry `file.copyPath`. |
| Share ▸ | 🚫 | macOS share sheet on source files is not a workflow MARVIN has. |

## Edit / Selection

The whole Edit menu except Find-in-Files is **AppKit's responder chain**:
Undo, Redo, Cut, Copy, Paste, Find, Find Next/Previous and Use Selection
for Find already work in every text view, and MARVIN deliberately does not
redeclare them — a custom implementation would shadow the system behaviour
with a worse one.

| Item | Status | Note |
|---|---|---|
| Undo / Redo / Cut / Copy / Paste | ✅ | Responder chain. |
| Find / Find Next / Find Previous | ✅ | `⌘F` / `⌘G` / `⇧⌘G`, Edit menu. |
| Find in Files | ✅ | `⇧⌘F` — reveals the Search pane. |
| Replace / Replace in Files | ⬜ | Search pane is read-only today. **Deferred deliberately:** a multi-file rewrite is a mutation, and MARVIN gates mutations (`gitWritePolicy`, the confirm registry). It needs a preview-and-confirm story, i.e. its own ADR — not a menu item. |
| Toggle Line Comment | ⬜ | Needs editor text manipulation; per-language comment tokens are already known to the syntax layer. |
| Toggle Block Comment | ✅ | ⌥⇧A. Per-language delimiters; Python deliberately has none (`"""` is a string literal, not a comment). |
| Move Line Up/Down, Copy Line Up/Down | ⬜ | Editor text manipulation. High value, self-contained. |
| Duplicate Selection | ⬜ | Same. |
| Expand / Shrink Selection | ✅ | ⌃⇧⌘→ / ⌃⇧⌘←. Bracket- and line-based, **not** the tree-sitter walk first planned: MARVIN wires 12 grammars, so a syntax version would do nothing in every other language — including Java, the language of the project that prompted this. Shrink replays the expand stack. |
| Add Cursor Above/Below, Add Next Occurrence, multi-cursor | ⬜ | The largest editor item. `STTextView` supports multiple insertion points; the commands and the UX are the work. |
| Column Selection Mode | ⬜ | Follows multi-cursor. |
| Emmet | 🚫 | Web-authoring specific. |
| AutoFill / Dictation / Emoji & Symbols | ✅ | System-provided in any text view. |

## View

| Item | Status | Note |
|---|---|---|
| Command Palette… | ✅ | **New** — `⇧⌘P`, over `CommandRegistry`. |
| Open View… | 🟡 | The palette covers it. |
| Appearance ▸ | 🟡 | Toggle Theme only; no zoom / full-screen submenu. |
| Editor Layout ▸ | ⬜ | Single editor column today. Split editors are a real gap. |
| Explorer / Search / Source Control | ✅ | **New** — `⌘B`, `⇧⌘F`, `^⇧S` reveal the left-pane tabs. |
| Run | ⬜ | Needs DAP. |
| Extensions | 🚫 | MARVIN has Skills and Plugins panes instead (ADR-0053); both are in the View menu. |
| Problems / Output / Debug Console / Terminal | 🟡 | Problems ✅ `⇧⌘M`, Terminal ✅ `^\``, Graph ✅ `^⇧G`, Preview ✅ `⇧⌘P`. No Output or Debug Console. |
| Word Wrap | ✅ | ⌥Z, persisted. Also re-routes the chat-link line jump, whose offset arithmetic assumed uniform line height. |

## Go

| Item | Status | Note |
|---|---|---|
| Back / Forward | ✅ | **New** — `^-` / `^⇧-`, browser-style stack in `MarvinBridge`. |
| Last Edit Location | ⬜ | Needs an edit-position record. |
| Switch Editor / Switch Group ▸ | 🟡 | Tab strip has ‹ › scroll buttons; no menu entries. |
| Go to File… | ✅ | `⌘P`. |
| Go to Symbol in Workspace… | ✅ | `⌘T` — graphify-backed, and now **jumps to the line**. |
| Go to Symbol in Editor… | ⬜ | Needs LSP `documentSymbol`. |
| Go to Definition / Declaration / Type Definition / Implementations / References | ⬜ | **Needs LSP** — the connection exists now; these are `textDocument/*` requests plus UI. |
| Go to Line/Column… | ✅ | **New** — `^G`, accepts `120` or `120:8`. |
| Go to Bracket | ✅ | ⇧⌘\\. Depth-counted scan, so `f(g(x), y)` reaches the outer close. Tries the character at the caret, then the one before it. |
| Next / Previous Problem | ✅ | **New** — `F8` / `⇧F8` walk the merged diagnostics list. |
| Next / Previous Change | ✅ | ⌥⌘↓ / ⌥⌘↑, over the gutter's existing hunks. Wraps at both ends. |

## Run

Every item needs a **Debug Adapter Protocol** client. MARVIN has no
debugger and no ADR for one. This is the single largest gap and the only
menu that is entirely empty.

| Item | Status |
|---|---|
| Start / Stop / Restart Debugging, Step Over/Into/Out, Continue | ⬜ Needs DAP |
| Breakpoints (toggle, enable/disable/remove all) | ⬜ Needs DAP |
| Add Configuration | ⬜ Needs DAP |

MARVIN's Run menu currently holds what it *can* run: Build Task, Run
Diagnostics, Audit Session.

## Terminal

| Item | Status | Note |
|---|---|---|
| New Terminal | ✅ | `^\`` toggles the terminal tab. |
| Split Terminal | ⬜ | **Deferred deliberately:** `TerminalSessionStore` is keyed by `workDir`, one session per project. Splitting means N sessions per project plus the pane UI to address them — a refactor, not a command. |
| New Terminal Window | 🚫 | Single-window. |
| Run Task… / Run Build Task… | ✅ | `⇧⌘B`, discovers from `package.json` / `Makefile` / `Package.swift` / `Cargo.toml`. |
| Run Active File | ✅ | Interpreter per extension (Golden Rule 6: that is a fact about Python, not about a project). Disabled — not failing in the terminal — where a language has no single-file run. Run Selected Text ⬜. |
| Show / Restart / Terminate Running Tasks | ⬜ | Needs a task registry. |
| Configure Tasks / Default Build Task | ⬜ | Needs a `tasks.json` equivalent. |

## Help

| Item | Status | Note |
|---|---|---|
| Search | 🟡 | The palette searches commands, not help. |
| Welcome | 🟡 | Onboarding exists under Help ▸ Show Onboarding. |
| Show All Commands | ✅ | **New** — the palette. |
| Editor Playground / Walkthrough | 🚫 | No tutorial content. |
| Provide Feedback | 🟡 | Help menu links to the repo. |
| Download Diagnostics | ✅ | **New** — Copy App Diagnostics puts version, project, branch, LSP state and log paths on the clipboard. |
| View License | 🟡 | Repo link. |
| Toggle Developer Tools | 🚫 | No WebView left to inspect (ADR-0075). |
| Open Process Explorer | ⬜ | Could list the sidecar, language servers and terminal PIDs. |

---

## Priority for the next passes

1. **Editor text commands** — line move/copy/duplicate, toggle comment,
   expand/shrink selection. Self-contained, high daily value, and
   expand/shrink is nearly free given tree-sitter.
2. **LSP consumers** — Go to Definition / References / Symbol in Editor,
   hover, and quick fixes. The transport shipped with ADR-0099; each of
   these is one request plus UI.
3. **Editor squiggles** — the ranges are already in `DiagnosticItem`.
4. **Multi-cursor** — the largest editor feature, and the one people
   notice missing most.
5. **Split editors** — needed before "Editor Layout" means anything.
6. **DAP** — the whole Run menu. Own ADR.
