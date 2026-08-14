# IDE feature gap — MARVIN vs Cursor and VS Code (2026-08-14)

What an IDE-with-an-assistant is expected to do, what MARVIN already does, and
what's missing — with a recommendation on which gaps are worth closing and which
are deliberate non-goals.

Sourced from vendor documentation, not blog roundups:
[VS Code AI features cheat sheet](https://code.visualstudio.com/docs/copilot/reference/copilot-vscode-features),
[VS Code smart actions](https://code.visualstudio.com/docs/editing/copilot-smart-actions),
[VS Code agents](https://code.visualstudio.com/docs/agents/overview),
[Cursor docs](https://cursor.com/docs).

---

## 1. Where MARVIN already stands

Worth stating plainly, because the gap list below is long and reads worse than
the reality. MARVIN already has the things that are *hard*:

| Capability | MARVIN | Notes |
|---|---|---|
| Agent that plans, edits, runs commands, self-corrects | ✅ | Plan/Agent/Ask modes, durable plan spine |
| Multi-file change review with per-hunk accept/reject | ✅ | ADR-0034 — against pre-agent baselines, not git HEAD |
| Codebase context beyond the open file | ✅ | Knowledge + code graphs, ~36× cheaper per question than file reads |
| Chat with file mentions (`@`) and slash commands | ✅ | ADR-0039, plus MARVIN-native commands |
| MCP servers, skills, plugins | ✅ | In-process + external, gated |
| Terminal (PTY) | ✅ | |
| Source control: stage/commit/push/pull/diff/branch | ✅ | |
| Search (ripgrep), symbol search, file history | ✅ | |
| Build tasks + diagnostics panel | ✅ | |
| Background jobs + scheduled follow-up turns | ✅ | ADR-0031/0038 — real turns, not narrated promises |
| Cost tracking, model picker, per-role effort | ✅ | |
| Durable memory, backlog, ADR trail | ✅ | Cross-session, in the project directory |
| Browser automation for verification | ✅ | Playwright CLI + gated MCP |

Cursor's and VS Code's own headline features — agent mode, codebase indexing,
multi-file edits, review, MCP, rules — all have MARVIN equivalents. The gaps are
concentrated in **editor-level interactions**, not in agent capability.

---

## 2. The gaps, by tier

### Tier 1 — editor-level AI (small, high daily value)

The pattern MARVIN is missing is *acting on what's under the cursor*. Everything
here reuses infrastructure that already exists.

| Gap | What the others do | Effort |
|---|---|---|
| ~~Smart actions on a selection~~ | Right-click → Explain / Review / Generate tests | **DONE 2026-08-14** |
| **Inline edit (⌘K)** | Select code, describe a change, get a diff applied in place | Medium |
| **Fix-from-diagnostic** | Lightbulb on an error → "fix this with AI" | Small |
| **AI commit message** | Source-control view generates it from the staged diff | Small |
| **Terminal inline chat** | ⌘I in the terminal: "what command does X", explain a failure | Small |
| **Generate tests** | Smart action that writes into the existing test file | Small |

**Inline edit is the biggest single miss.** It's the interaction Cursor is
organised around, and MARVIN has every piece already: a selection, a model, and
a per-hunk diff reviewer (ADR-0034). What's absent is the prompt-over-selection
entry point and applying the result as a reviewable change rather than a chat
message.

### Tier 2 — IDE fundamentals MARVIN lacks

These aren't AI features; they're what makes an editor an IDE.

| Gap | Impact | Note |
|---|---|---|
| **LSP integration** | **Largest structural gap.** No go-to-definition, find-references, hover types, signature help, or rename-symbol | MARVIN has tree-sitter (syntax) and graphify (structure), but neither knows *types*. `⌘-click a symbol` is table stakes |
| **Outline / breadcrumbs** | No per-file symbol tree or path bar | Cheap — tree-sitter already parses it, and symbol search exists |
| **Command palette (⌘⇧P)** | ⌘P opens files; there's no command surface | Small; discoverability has bitten this project twice |
| **Test explorer** | No per-test run/status | MARVIN runs suites via terminal/background jobs, but can't show a tree |
| **Split editor** | One editor pane | Medium |
| **Rename symbol (F2)** | Project-wide rename | Needs LSP, or graphify + careful text edits |
| **Format on save** | No formatter integration | Small |
| **Minimap** | — | Cosmetic; skip |

### Tier 3 — deliberate non-goals

Worth writing down so they aren't re-litigated.

- **Inline ghost-text completion (Tab).** Cursor's most-used feature, and the
  one MARVIN should *not* copy. It needs a fast fill-in-the-middle model
  answering in tens of milliseconds on every keystroke. That means a second
  model provider and a hot path that is not the Agent SDK — which cuts against
  the local-first, one-provider trust model the white paper argues for. Revisit
  only if Anthropic ships a completion-shaped endpoint.
- **Full debugger (breakpoints, step, watch).** Enormous surface. MARVIN's
  existing answer — run it, read the output, fix it — covers most of the value
  at a fraction of the cost.
- **Extension marketplace.** Plugins + skills + MCP already cover extensibility
  (ADR-0053/0054) without a VS Code-compatible API surface.
- **Cloud/background agents in VMs.** Cursor 3.5 ships these. It's the multi-
  agent direction Golden Rule 1 exists to avoid; MARVIN's background jobs and
  scheduled wakeups cover "work continues past the turn" without fan-out.

---

## 3. Recommended order

1. ~~**Editor smart actions**~~ — done.
2. **AI commit message.** Smallest remaining item with daily payoff; the diff is
   already available to the source-control view.
3. **Fix-from-diagnostic.** Connects the diagnostics panel that already exists
   to the assistant that already exists. Pure wiring.
4. **Inline edit (⌘K).** The one that changes how the editor feels. Should land
   its result in the existing change-review flow, not as chat prose.
5. **Outline / breadcrumbs.** Cheap given tree-sitter; makes long files navigable.
6. **LSP.** The big one. Decide deliberately — it's a subsystem (server
   lifecycle per language, protocol plumbing, capability negotiation), not a
   feature. Everything in Tier 2 that matters depends on it.

**A note on sequencing.** Items 2–4 make MARVIN a better *assistant*. Item 6
makes it a better *editor*. They compete for the same time, and the honest
question is which MARVIN wants to be: today it is an excellent assistant with a
serviceable editor attached, and the assistant-side gaps are far cheaper to
close than the editor-side ones.

---

## 4. What this analysis does not cover

- No measurement of how often any of these are used in practice — the priority
  ordering is reasoned, not observed.
- Cursor's docs are thin on editor mechanics (they describe agents, not
  keybindings), so the Cursor column leans on the VS Code equivalents where
  the interaction is the same.
- Effort estimates are relative, not hours.
