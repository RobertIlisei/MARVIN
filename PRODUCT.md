# Product

<!-- impeccable:product-schema 1 -->

## Platform

adaptive

The platform field is recorded as `adaptive` at the user's choice because Impeccable's schema has no macOS value. The real surface is a native macOS 14+ app (SwiftUI, STTextView, SwiftTreeSitter), not an iOS or Android app. Impeccable's iOS and Android guidance is the closest Apple-platform reference and applies only by analogy. Web-oriented guidance (CSS, live mode) does not apply: the sidecar is API-only and its browser UI was removed (ADR-0075).

## Users

A working software developer on macOS who pair-programs with one AI assistant on their own project. They set the vision and the business calls. MARVIN handles architecture, infrastructure, code, tests, docs and security, with the user as continuous overwatch.

## Product Purpose

MARVIN (Moderately Advanced Robotic Virtual Intelligence Network) is a pair-programming AI assistant delivered as a native macOS IDE shell: file tree, editor, chat, source control, terminal, diff and change review, and a live view of the project's knowledge graph. It reads the codebase, proposes a plan, executes with explicit confirmation, verifies against a stated Definition of Done, and commits. Success is work that ships without the user losing track of what the assistant did or why.

## Positioning

One assistant with enforced discipline, not an agent team. The knowledge graph is consulted before files are read. A deterministic tool gate enforces the rules (allow, confirm, deny) instead of politely requesting them in the prompt. It is local-first with no backend: credentials stay on the machine and inference goes straight to Anthropic or OpenRouter. A neighbouring IDE agent could not truthfully copy the gate plus the nightly Practice loop, which turns repeat failures into approved rules and measures whether they held.

## Operating Context

- A SwiftUI app (`macos/`) talks over loopback (`localhost:3030`) to a bundled Next.js sidecar (`sidecar/`) that runs the Claude Agent SDK, tool policy, git and file APIs, and session storage.
- Work is organised as several chat tabs at once. Each new tab gets its own git worktree and branch (or is a shared-checkout tab by choice), and the Sessions pane shows what needs the user, what is working, and what is ready to integrate.
- Three modes: Ask (read-only), Agent (full autonomy), Plan (a plan the user approves before execution).
- The left pane has seven panes: Files, Search, Source Control, Sessions, Skills, Plugins and Practice. They share one control vocabulary (ADR-0114).
- Decisions reach the user as native option buttons, and permission confirms arrive as cards in the tray.
- Distribution is Homebrew cask `marvin-ai`, ad-hoc signed with a one-time Gatekeeper step, with minisign-signed release zips.

## Capabilities and Constraints

- Keyboard-driven surface: the menu bar, the ⇧⌘P command palette and the ⌘/ shortcut sheet are renderings of one command registry, so bindings cannot drift.
- Review is a first-class surface: per-hunk and per-file accept/reject against pre-agent baselines, in a separate resizable side-by-side diff window.
- Plans are tracked: `[N]` / `[N.M]` tagged steps, a persistent plan strip, and the plan saved under `.marvin/plans/`.
- Constraints that shape any UI work: one assistant per tab (no multi-agent dispatch surface); long transcripts must stay fast (lazy rows, windowed history); layout loops are a known failure class on macOS (ADR-0062), so layout changes should be measured, not guessed.
- Terminology to preserve: tab, session, worktree, plan, scope met, Practice, gate, graph, backlog.
- Undecided: whether MARVIN has a visual design language beyond the native macOS system look. This record does not decide it.

## Brand Commitments

- Name and persona: MARVIN, with an optional dry-wit voice (`personality: "marvin" | "neutral"`), a style layer rather than a refusal layer.
- The user's project is a separate workspace; MARVIN holds no cross-project knowledge. UI must never blur one project's context into another's.

## Evidence on Hand

- Real session screenshots and animated diagrams: `docs/assets/` (IDE, plan mode, agent mode, change review, decision dialog, Practice panes).
- Prose references: `README.md`, `docs/whitepaper/WHITEPAPER.md`, `docs/getting-started/`, `docs/guides/`, `docs/reference/ide-parity.md`.
- No testimonials, customer names, benchmarks beyond those measured in the repo's own docs, or pricing exist; do not invent them.

## Product Principles

1. The user is overwatch: every consequential action is visible, attributable and reversible before it lands.
2. Enforced beats requested: if a rule matters, the interface shows the gate that holds it, not a promise.
3. Many sessions, one clear state: at a glance the user can tell what needs them, what is working and what is done.
4. Native and keyboard-first: the app behaves like a macOS IDE, and every action is reachable from the registry.
5. Measure, don't guess: layout and performance claims are verified against what runs.
