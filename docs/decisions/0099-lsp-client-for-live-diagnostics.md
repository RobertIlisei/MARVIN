# ADR-0099 — An LSP client, because a CLI runner can never be an editor

- **Status:** Accepted
- **Date:** 2026-08-31
- **Related:** [ADR-0012](./0012-source-control-mutation-channel.md) (the shell-out discipline this reuses), [ADR-0021](./0021-native-macos-shell.md) (the native shell that owns the editor), [ADR-0022](./0022-pure-logic-in-marvinlogic.md) (why the framing codec is pure), [ADR-0075](./0075-sidecar-drops-browser-ui.md) (the app is the only client)

## Context

The Problems panel shells out to CLIs — `tsc --noEmit`, `eslint`, `mvn
compile` — and parses stdout. On 2026-08-31 that surface was rewritten:
discovery now walks the tree, eight toolchains are supported, results are
grouped and filterable, and rows jump to `file:line:col`. It works.

It also cannot ever be what the user is comparing it to.

VS Code's Problems panel — and therefore Cursor's, Antigravity's and
Windsurf's — is a **passive renderer over a diagnostics collection**.
Producers push into that collection; the panel just draws it. The dominant
producer is a **language server** speaking LSP over stdio, publishing
`textDocument/publishDiagnostics` as you type. That single fact is the
source of four capabilities we cannot reach by running a CLI:

| Capability | Why the runner can't |
|---|---|
| Diagnostics as you type | A run is seconds-to-minutes and reads the file **from disk**; the buffer you are editing has not been saved. |
| Squiggles in the editor | Needs a *range* (start line/col → end line/col). CLI output gives one point. |
| Quick fixes | `textDocument/codeAction` returns a workspace edit. There is no stdout format that carries one. |
| Hover, go-to-definition, rename | Not diagnostics at all — but they arrive over the same connection, from the same server, for free once it exists. |

Freshness is the part that bites daily. A CLI run type-checks what is on
disk; the panel then confidently describes a file the user has already
fixed, or misses the error they just introduced. That is worse than a
stale list — it is a *wrong* list that looks authoritative.

The counter-argument, stated fairly: an LSP client is a long-lived
subprocess per language per project, with a handshake, a lifecycle, and a
failure mode (server crashes, server hangs, server eats 2 GB) that a
one-shot `Process` does not have. This is real cost.

## Decision

**Add an LSP client, and keep the CLI runners.**

They answer different questions and neither subsumes the other:

- The **language server** owns the open buffer. Live, per-keystroke,
  range-accurate, and the only path to code actions. Scoped to files the
  user actually has open.
- The **CLI runner** owns the whole project. `tsc` sees every file
  including the ones nobody opened; `mvn` and `cargo` see the real build.
  A language server started on one open file will not tell you the module
  three directories over stopped compiling.

Both publish into the same `MarvinBridge.diagnosticItems` collection, each
tagged with its `source`, deduped on `(severity, file, line, col, message)`
— which is what stops `tsc` and `typescript-language-server` reporting the
same error twice.

### Shape

1. **`LSPClient`** — one per (server, project root). Spawns the server on
   stdio, speaks JSON-RPC 2.0 with LSP's `Content-Length` framing, and
   owns the lifecycle: `initialize` → `initialized` → N ×
   `didOpen`/`didChange`/`didClose` → `shutdown`/`exit`.
2. **`LSPMessageFraming`** — the wire codec, in `MARVINLogic`, **pure**
   (ADR-0022). Framing bugs are the classic source of a client that
   silently wedges: a header parsed one byte off desynchronises the stream
   forever, with no error. Pure means it is pinned by tests without a
   running server.
3. **`LSPServerRegistry`** — how to recognise a language and what to
   launch, resolved project-local-first like the diagnostic toolchains
   (`node_modules/.bin` before Homebrew before PATH).
4. **`LSPService`** — one per project. Routes editor open/change/close to
   the right client, merges every server's diagnostics, and hands them to
   the bridge.
5. **Editor squiggles** — the ranges LSP gives us, drawn as underlines in
   the `STTextView`, alongside the existing syntax highlighting.

### Rules of note

- **Debounced `didChange`, and full-text sync.** Incremental sync is an
  optimisation with an entire class of desync bugs behind it; full text at
  150 ms is correct by construction and cheap at the file sizes an editor
  holds open.
- **A server that fails to start is surfaced AS a diagnostic**, never
  swallowed. Returning nothing is indistinguishable from "no problems" —
  the exact failure that made the old Problems panel look dead for months.
- **Crash budget.** A server that dies three times for one project is not
  restarted again; the panel says so. An editor that respawns a crashing
  subprocess forever is a battery bug.
- **No `workspace/didChangeWatchedFiles`.** MARVIN already refreshes on
  turn completion; adding a file watcher per server duplicates it.
- **Servers are never installed by MARVIN.** If `sourcekit-lsp` is absent
  the panel says so and the CLI runner still covers the project. Installing
  toolchains behind the user's back is not this feature's job.

### Deliberately deferred

Hover, go-to-definition, completion, rename, formatting and code actions
all arrive on this connection and are all real follow-ups. They are not in
this ADR because each needs UI, and shipping the transport plus one
consumer (diagnostics) is what proves the transport.

## Consequences

**Positive.** Diagnostics become live and range-accurate; squiggles become
possible; the entire language-intelligence family becomes a UI question
rather than an architecture question. The panel stops lying about files
the user has already fixed.

**Negative.** A long-lived subprocess per language per project, with a
lifecycle to get right and a crash path to handle. A second diagnostics
producer means dedupe is now load-bearing — get it wrong and every error
appears twice. And the servers themselves are the user's to install, so
the feature's usefulness varies by machine, which is a support surface.

**Rejected — routing LSP through the sidecar.** The sidecar is where
MARVIN's Node lives, so it looks like the natural host. It is not: the
editor buffer lives in the Swift app, and `didChange` must fire on
keystrokes. Round-tripping every keystroke through HTTP to Node and back
adds latency to the one path that must not have any, and puts a process
boundary between the buffer and the thing modelling it.

**Rejected — tree-sitter instead.** MARVIN already parses 12 languages
with tree-sitter, and its `ERROR` nodes are free syntax diagnostics. But
syntax errors are the ones you already know about; the useful diagnostics
are semantic ("no such method", "type mismatch"), which need a type
checker. Worth adding later as a zero-cost extra source — not a substitute.

## Scope of Done

- [ ] `LSPMessageFraming` encodes and decodes `Content-Length` framing,
      including a split read and two messages in one buffer, pinned by
      tests that run without a server.
- [ ] `LSPClient` completes a real `initialize` handshake against a real
      server and reports the server's advertised capabilities.
- [ ] Editing an open file produces `publishDiagnostics` and the Problems
      panel updates without the user running anything.
- [ ] LSP and CLI diagnostics coexist in one list, deduped, each showing
      its source.
- [ ] A missing or crashed server appears in the panel as a warning naming
      what was tried — never silence.
- [ ] Verified against `sourcekit-lsp` on this repo's own Swift sources.
