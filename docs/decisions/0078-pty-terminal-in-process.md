# ADR-0078 — The terminal is a real PTY, owned by the app

- **Status:** Accepted
- **Date:** 2026-08-29
- **Related:** [ADR-0022](./0022-pure-logic-library.md) (where `PTYProcess` lives and why), [ADR-0075](./0075-sidecar-drops-browser-ui.md) (the sidecar is API-only)

## Context

The terminal pane ran every command as a fresh `$SHELL -c` through
`/api/terminal/run` and rendered the SSE stream. Three user reports in one
afternoon: it printed nothing (an SSE framing bug, fixed separately), then
`[exit 0 · 0.01s]` after every command, then *"is the terminal not
persistent? shouldn't it behave like a normal terminal"* — plus a text field
that lost focus on every Enter. All four are the same fact: it was a
command runner, not a terminal. `cd` did not persist, Ctrl-C did nothing,
no colours, no `vim`.

## Decision

**A persistent login shell on a pseudo-terminal, spawned by the app, rendered
by SwiftTerm.**

- `MARVINLogic/PTYProcess` — `posix_openpt` + `posix_spawn` with
  `POSIX_SPAWN_SETSID`, the slave opened as fd 0 **in the child** so it becomes
  the controlling terminal. That ordering is the whole point: without it there
  is no foreground process group and Ctrl-C is swallowed while everything else
  looks fine. The test suite spawns `/bin/sh`, runs `sleep 30`, sends `0x03`
  and requires the shell to answer within 3 s. Reads and the exit wait are two
  blocking threads (`read(2)` / `waitpid(2)`); a `DispatchSource` process
  watcher was tried first and crashed in `_dispatch_source_merge_evt`.
- `MARVINLogic/TerminalEnvironment` — scrubs what MARVIN injects
  (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`, Honeycomb/OTEL keys) so
  `printenv` in the user's shell never echoes a credential, keeps the user's
  own tokens, sets `TERM=xterm-256color`, defaults `LANG` to UTF-8 and
  prepends Homebrew to `PATH` for Finder launches. `argv[0] = "-zsh"` makes
  it a login shell so rc files run.
- `TerminalSessionStore` owns sessions per project **outside the view** — a
  hidden pane no longer kills the shell — and `applicationWillTerminate`
  hangs them all up (SIGHUP to the session, SIGKILL after 1.5 s), so no shell
  outlives the app.
- SwiftTerm is the **renderer only** (added to both `Package.swift` and
  `project.yml`). Its `LocalProcess*` helpers are unused: env scrubbing,
  teardown and tests stay in code MARVIN owns.
- Build tasks type into the same shell via `bridge.pendingTerminalCommand`,
  even when the pane is hidden. The whole pane is the terminal: it takes
  focus on appear and on click.
- Deleted: `/api/terminal/run`, `ANSIParser.swift`, the `@xterm/*` deps.

### Why not node-pty in the sidecar

A second native Mach-O in a bundle that already carries scar tissue for one,
and a blocker for notarization; Next cannot hold a WebSocket in standalone,
so every keystroke would be an HTTP round-trip; and a sidecar-owned shell
survives an app crash as an orphan. The route it would have extended was an
unaudited shell-exec surface that never consulted the tool policy.

## Consequences

- `cd` persists, Ctrl-C works, colours and full-screen programs work; the
  focus and exit-line complaints are gone by construction.
- The Swift test suite gains 8 environment + PTY assertions, including the
  Ctrl-C gate.
- Not in scope: multiple tabs per project, a "run in terminal" for MARVIN's
  own Bash calls, and the tabbed bottom panel (plan §D).

## Addendum (2026-09-09) — the controlling tty was never attached, and tabs

**The bug.** User: *"commands in terminal do not work"*, with a screenshot of
`^Z^[^C^C^C` echoed under a running dev script. Measured before touching
code: the app's shell had fds 0–2 on `/dev/ttys005` and **no controlling
terminal** — `ps` tty `??`, foreground group `0`, `ps -t ttys005` empty —
with `isig` on. The line discipline was turning `0x03` into SIGINT for a
foreground process group that did not exist. Reproduced outside the app with
the same `posix_spawn` shape: `cat` ends with no controlling tty, `zsh -f`
ends with none, `/bin/sh` (bash) ends with one. The Decision section above
was wrong about the ordering: the file-action open runs before the child is
a session leader, so nothing is acquired. The Ctrl-C test passed only because
bash re-opens its tty by name at job-control init and attaches itself; zsh,
the user's shell, does not.

**The fix.** `forkpty(3)` — `openpty` + `fork` + `login_tty` (`setsid`,
`TIOCSCTTY`, dup onto 0/1/2). Between the fork and `execve` the child runs
only async-signal-safe calls (signal reset, `chdir`, exec) on C strings and
arrays built before the fork. `posix_spawn` is gone from `PTYProcess`. The
suite now pins acquisition with `zsh -f` — `ps -o tty= -p $$` must not be
`??`, and `sleep 30` must die on `0x03` — the shell that does not attach
itself.

**Tabs.** "Not in scope: multiple tabs per project" is now in scope (user:
*"open multiple terminals … switch between them without killing them"*).
`TerminalSessionStore` holds an ordered list of sessions per project and an
active id; `session(for:)` returns the active one so build tasks, the file
tree's *open here* and the command registry keep landing in the tab the user
is looking at; `newSession`, `activate` and `close` are the only verbs.
Switching swaps the SwiftTerm view through the existing session-swap path
in `PTYTerminalView` and never touches a shell; only closing a tab hangs its
shell up. Tab numbers are per project and never reused.
