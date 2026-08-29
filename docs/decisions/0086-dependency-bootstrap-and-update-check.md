# ADR-0086 — MARVIN installs its own toolchain, and tells you when it's out of date

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0085](./0085-graphify-beyond-search.md) (the graphify surface this makes reachable), [ADR-0038](./0038-background-jobs-event-wakeups.md) (why there is no auto-update), Golden Rule 7

## Context

Three gaps surfaced together.

**1. graphify was "advisory".** `bin/marvin doctor` printed a dim line saying
graphify wasn't on PATH and left it there. But Golden Rule 7 makes the graph
the *first* thing MARVIN consults on any structural question — so a fresh
machine had a MARVIN whose central rule silently degraded to grep-and-pray,
with nothing saying so. Everything ADR-0085 added is unreachable without that
binary.

**2. Nothing kept the graph fresh outside the IDE.** ADR-0041's watchdog only
runs while MARVIN is open on a project. Verified on this repo and the user's:
graphify's post-commit / post-checkout hooks and the `graph.json` union merge
driver were **all "not installed"**.

**3. MARVIN had no update path at all.** A user on 0.1.65 stayed there until
they happened to run `brew upgrade`. The tap had in fact been three releases
behind for a day without anyone noticing.

## Decision

**`bin/marvin deps [check|install]`** — one command for the whole external
toolchain: graphify (via `uv`, else `pipx`), the Claude Code CLI, the skill
bundle, and a Playwright advisory. `install-macos-app` runs `deps install`
first, so installing the app installs what the app needs. `MARVIN_SKIP_DEPS=1`
opts out, and a missing dependency warns rather than blocking the install —
being unable to rebuild a graph must not stop you getting the app.
`scripts/install.sh` gains the same graphify step for the curl-install path.

**`bin/marvin graph-hooks [path] [install|uninstall|status]`** wraps
`graphify hook install`: post-commit rebuild, post-checkout rebuild, and the
union merge driver that stops a 93k-edge `graph.json` conflicting on every
branch merge.

**An update check.** `UpdateService` reads the GitHub Releases API 8 s after
launch and then daily, comparing the newest tag to the running bundle.
`MARVINLogic.UpdateCheck` holds the decision and is test-pinned, because the
rules are easy to get quietly wrong:

- versions compare **numerically**, component by component — a string compare
  makes `0.1.9 > 0.1.10` and the prompt would never fire past `.9`;
- the running build's `+sha` suffix is stripped, so `0.1.71+a43b044` equals
  release `v0.1.71`;
- a dev build **ahead** of the latest release is never told to "update";
- an unparseable version on either side decides *nothing* rather than guessing;
- **skip is per-version** — skipping 0.1.71 stays quiet until 0.1.72 ships.

**No auto-install, deliberately.** MARVIN holds live agent turns and
background jobs; swapping the bundle underneath one kills work that reports
nothing back (ADR-0038: a SIGTERM'd job fires no completion turn). The prompt
hands over `brew upgrade --cask marvin-ai` with a copy button and says to quit
first. There is also a **Check for Updates…** menu item, which bypasses both
the daily gate and any skipped version.

**Privacy:** one unauthenticated GET a day to a public endpoint. Nothing about
the user, their projects, or their usage is sent. Every failure path — offline,
rate-limited, unrecognised shape — is silent.

### Also fixed here

A cancelled request is not an error. `Task.cancel()` on a URLSession call
surfaces as `URLError(.cancelled)` / −999, **not** `CancellationError`, so the
file tree's `catch is CancellationError` missed it — and the ADR-0077
auto-refresh made that routine: FSEvents fires, the in-flight fetch is
cancelled, and the user got a red "Fetch error … Code=-999 'cancelled'" banner
full of NSError internals for something that worked.
`MARVINLogic.BenignCancellation` classifies all of its shapes, including the
wrapped-underlying-error form the user actually saw.

## Consequences

- A fresh install has a working graph toolchain instead of a silently
  degraded Golden Rule 7.
- Graphs stay fresh when MARVIN is closed; `graph.json` stops conflicting.
- Users learn about releases the day they ship rather than whenever they
  happen to run brew.
- The daily check is one request; if GitHub rate-limits an unauthenticated
  caller, the check simply doesn't happen that day.

## Scope of Done

- [x] `bin/marvin deps` installs graphify + verifies the CLI and skills;
      wired into `install-macos-app` and `scripts/install.sh`
- [x] `bin/marvin graph-hooks` installs/uninstalls/reports the hooks; run on
      both this repo and the active project
- [x] Update check daily + on demand, with a non-auto-installing prompt
- [x] Version comparison, scheduling and per-version skip are test-pinned
- [x] Cancelled requests no longer surface as errors
- [ ] Not in scope: auto-update, a Sparkle-style delta updater, notarization
