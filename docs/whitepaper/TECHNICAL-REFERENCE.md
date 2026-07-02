# MARVIN — Technical Reference

*The exhaustive companion to the [white paper](./WHITEPAPER.md): every
subsystem, its logic, the decision record behind it, and pointers into the
code. Written for contributors and deep evaluators. Covers v0.1.55.*

> **Status: structure agreed, sections being drafted.** Each section below
> is filled from the complete feature inventory (2026-07-02) with
> file/ADR citations.

---

## 1. Core loop & modes

[To be written — single-assistant loop, 8-phase workflow, Ask/Agent/Plan,
plan card, two-tier todos, plan-as-durable-spine (reconcile not clobber),
step join keys + roll-up, plan persistence/replay, plan file mirroring,
Continue anchoring, plan-in-context injection, AskUserQuestion,
session-history paging.]

## 2. Permission & safety

[To be written — structural confirm gate, auto/gated strategies,
classifyToolCall, auto-mode audit floor, hard-deny patterns, subagent
read-only invariant, change checkpoints + review window + revert
semantics, FS write policy + sandbox, git argv guards + write policy +
credential inheritance, shell-backgrounding denial, runtime design
hooks.]

## 3. Context & knowledge

[To be written — graphify-first rule, code + knowledge graphs, scopes,
the six marvin-graph MCP tools, auto-rebuild lifecycle, first-message
context budgeting, project fingerprint, infra probes.]

## 4. Cross-session persistence

[To be written — memory MCP (remember/recall, content-class guards),
memory-compact, session notes, backlog MCP + capture-at-discovery,
plans directory, ADRs, transcripts, cost tracker, the three-layer
ramification stack.]

## 5. Subagents

[To be written — advisor (registered agent, triggers), scout, dynamic
read-only fan-outs, the ADR critique pass, enforcement mechanics.]

## 6. Skills

[To be written — enablement/active set, deterministic triggers, skill
audit + two-verb recommendations, fetch-from-git installer, adopted
skill set.]

## 7. Models & auth

[To be written — role routing (executor/advisor/planner), per-role
effort, auth mode resolution, keychain read, live model discovery.]

## 8. UI surfaces (macOS app)

[To be written — IDE shell, chat surface, editor + diff gutter +
tree-sitter, file tree, terminal, preview, source control, backlog
panel, context-usage panel, review window, brain visualization, quick
open / symbol search / find-in-files / build tasks / diagnostics,
onboarding + settings.]

## 9. Background & async

[To be written — background jobs (event-based completion turns,
shutdown-signal semantics), scheduled wakeups + yield rules, announce
SSE, one-live-turn rule, authoritative stop, resume across reloads,
git-watch.]

## 10. Distribution & operations

[To be written — Homebrew cask, bundled sidecar + port ownership,
minisign signing, macOS 26 Gatekeeper handling, install/uninstall/zap,
health monitoring + hysteresis, lifecycle CLI, Honeycomb telemetry
export (opt-in).]

## 11. Behavioral contracts (`personality.ts`)

[To be written — the firm-surfaces catalogue: phase gating, Definition
of Done / match-not-improve, verify-then-remediate, deterministic ADR
triggers, post-PR loop, async anti-fabrication, workflow health audit,
greenfield playbook, personality toggle.]

## 12. API & MCP surface

[To be written — the sidecar HTTP API by route group; the four
in-process MCP servers + the gated external Playwright MCP; gate
classification per server.]

## 13. Deliberate non-goals

[To be written — no multi-agent implementation, no cross-project
memory, no hosted service, no cross-platform (yet), no auto-model
heuristics; the reasoning for each.]

---

*Generated against the 2026-07-02 feature inventory. The repository is
authoritative where this document lags.*
