# Running and watching several MARVIN sessions at once — research report

- **Date:** 2026-09-09
- **Asked by:** the user, after running three sessions against one checkout and being able to see only one transcript at a time ("i have 3 sessions running simultaneously but i want marvin to be able to run multiple sessions simultaneously, perhaps we need some sort of environment constraints or sandboxes? How does anthropic fix this? What does their documentation say? Or is there any other proven with hard evidence way of doing this?")
- **Method:** deep-research workflow — 5 search angles, 24 sources fetched, 120 claims extracted, 25 sent to a 3-vote adversarial verification (budget-capped), **25 confirmed, 0 refuted**, merged into 14 findings. 106 agents, 6.9 M tokens, 15.4 min. Every surviving claim is from Anthropic primary documentation or the `anthropics/claude-code` issue tracker. See *What this research could not establish* before acting on any number.
- **Related MARVIN decisions:** [ADR-0081](../decisions/0081-implementer-subagents-on-isolated-worktrees.md) (implementer subagents on worktrees), [ADR-0102](../decisions/0102-multiple-sessions-one-worktree.md) (two sessions, one worktree, HEAD-moving confirm), [ADR-0103](../decisions/0103-implementer-branch-lifecycle.md) (worktree lifecycle derived from git), [ADR-0073](../decisions/0073-agent-sdk-0-3-upgrade.md) (SDK pins)

## The answer in brief

1. **The collision you saw is the documented default.** Anthropic's docs say sessions, forks, resumes and file checkpoints persist *the conversation, not the filesystem*. Two sessions in one directory see each other's edits immediately. Nothing in the session model isolates anything. [F0]
2. **Anthropic's own answer for exactly your scenario is one git worktree per session.** `claude --worktree`, `EnterWorktree`, subagent `isolation: worktree`, and — the revealed preference — the Claude Code desktop app gives *every new session its own worktree automatically*. Since CLI v2.1.218 that isolation is enforced by four tool-call checks, not by convention. [F1, F2]
3. **Sandboxes do not solve this.** The built-in Bash sandbox and `@anthropic-ai/sandbox-runtime` are access-control layers (filesystem read/write scope, network egress). They contain a session's blast radius on the host; they say nothing about two sessions sharing one working tree, and Anthropic says so. [F10]
4. **Agent teams are not available to MARVIN** (off in `-p`/SDK sessions) and would not isolate anyway; Anthropic's fallback for a shared checkout is partitioned file ownership — which is what MARVIN's ADR-0102 confirm already approximates. [F4]
5. **Cloud sessions give the strongest isolation but are decoupled from the local checkout** and GitHub-centric; the GitLab monorepo gets a bundle-upload fallback that cannot push back. [F11]
6. **A multi-session watch UI can be built on supported SDK calls** (`listSessions`, `getSessionInfo`, `getSessionMessages`, `renameSession`, `tagSession`) plus each `query()` stream for live state, and Anthropic ships two UI precedents to copy: the agent panel (status rows, one transcript at a time, idle rows collapse) and Claude Code on the web (sidebar with a `+42 −18` diff badge per session, inline-comment diff view, "expired" markers). [F6, F8, F9]
7. **No hard numbers survived.** No benchmark, third-party manager, or 2025–26 paper on shared-repo concurrency made it through verification, so there are no measured conflict rates, throughput or cost figures in this report. The ranking below is by documented properties. [Caveats]

## What is documented (14 verified findings)

Confidence and vote are the verifier panel's. "3-0, 3-0" means two merged claims, each unanimous.

**F0 — Sessions isolate nothing.** *high, 3-0 ×2.* "Sessions persist the conversation, not the filesystem." "Forking branches the conversation history, not the filesystem. If a forked agent edits files, those changes are real and visible to any session working in the same directory." Resuming one session in two processes interleaves both into one transcript. File checkpointing is per-session, tracks only Write/Edit/NotebookEdit (not Bash or subagent edits), and is a rewind of the shared tree, not a separate view. The sessions page's own "see also" points at worktrees for isolated parallel sessions.
Sources: code.claude.com/docs/en/sessions · /agent-sdk/sessions · /agent-sdk/file-checkpointing · /worktrees

**F1 — Worktrees are the official primitive.** *high, 3-0 ×2.* `claude --worktree <name>` creates `.claude/worktrees/<name>/` on branch `worktree-<name>`; a second parallel session is another invocation with another name. The desktop app: "every new session gets its own worktree automatically" (default-on chip, Git repos only). Subagents: `isolation: worktree` gives a temporary worktree, auto-removed if unchanged. **By default a worktree branches from the remote default branch (`worktree.baseRef: fresh`), not from your HEAD** — `baseRef: head` is required to carry uncommitted/unpushed work.
Sources: /worktrees · /desktop · /sub-agents · issues #45371, #57768, #50850, #41368, #76415

**F2 — Isolation is harness-enforced (≥ v2.1.218).** *high, 3-0 ×2.* Four checks: (1) Edit/Write/NotebookEdit into the main checkout are blocked; (2) Bash/PowerShell/Monitor whose cwd resolves to the main checkout; (3) git redirected into it via `git -C`, `--git-dir`, `GIT_DIR`/`GIT_WORK_TREE`, or `cd`; (4) commands whose git scope cannot be verified from the command text (not disableable). Applies to every subagent spawned from an isolated session. Before v2.1.203/210/218 it was leaky (a subagent `git switch` moved the parent's HEAD, issue #55708). Not covered: MCP-tool writes and non-git absolute-path writes — it is tool/git-level, not a filesystem sandbox. **No independent field test of the four checks was found; treat as documented, not verified.**
Sources: /worktrees §How Claude Code enforces isolation · /sub-agents version history · issues #55708, #76197 (open), #39886

**F3 — What a worktree does *not* isolate.** *high, 3-0.* The `.git` directory, project-scope plugins, and saved permission approvals (v2.1.211+: approvals write to the main checkout's `.claude/settings.local.json` and apply everywhere). A worktree is a fresh checkout: no gitignored files (`.env`), no installed dependencies. `.worktreeinclude` copies gitignored files but installs nothing. Branch/ref mutations through the shared `.git` are outside the isolation checks.
Sources: /worktrees §What worktrees share · issues #13019, #36788, #36360

**F4 — Agent teams are not MARVIN's primitive.** *high, 3-0 ×2.* Experimental, off by default, and "in non-interactive mode with the -p flag, including Agent SDK sessions, Claude doesn't spawn teammates." Even where available, "Agent teams don't isolate teammates in worktrees … Two teammates editing the same file leads to overwrites. Break the work so each teammate owns a different set of files." Third-party blogs claiming per-teammate worktrees contradict the docs and were discounted.
Sources: /agent-teams · /agents · /agent-sdk/subagents · /headless

**F5 — Track your own session ids; resume by id.** *high, 2-1 then 3-0.* `-p`/SDK sessions are excluded from the CLI picker and `claude --continue`; `continue: true` picks the most recent session in the cwd and is documented for one-conversation-at-a-time apps. With several tabs on one directory, `resume` by the id from the init `SystemMessage` / `ResultMessage.session_id` is the required path. A session resumed after living in a worktree returns to that worktree (SDK included).
Sources: /sessions §Resume · /agent-sdk/sessions · issue #42311

**F6 — Supported APIs for a watch UI.** *high, 3-0 ×2.* `listSessions({dir, limit, includeWorktrees})`, `getSessionMessages(id, {dir, limit, offset})`, `getSessionInfo`, `renameSession`, `tagSession` are documented "to build custom session pickers, cleanup logic, or transcript viewers". Subagent transcripts: `~/.claude/projects/{project}/{sessionId}/subagents/agent-{id}.jsonl`. `/tasks` lists a session's background work. **The raw JSONL format is explicitly internal and version-unstable.** These read persisted transcripts, not live streams; live state comes from each `query()` message stream.
Sources: /agent-sdk/sessions · /agent-sdk/typescript · /sub-agents · /commands · /sessions
*Correction to the workflow's caveat:* MARVIN pins `@anthropic-ai/claude-agent-sdk ^0.3.251` (workspace and bundle checked 2026-09-09), whose `sdk.d.ts` exports all five calls. No SDK upgrade is needed.

**F7 — Attention routing precedent.** *high, 3-0.* Background subagents surface permission prompts in the parent session naming the asker (v2.1.186+); a lasting grant there applies to the whole session. Nested subagents render as a tree with `(+N)` descendant counts. Scope trap: a "don't ask again" grant is saved to the main checkout's `settings.local.json` and applies to every worktree of that repo.
Sources: /sub-agents · issue #34095

**F8 — Anthropic's agent panel.** *medium, 2-1.* A panel below the prompt lists each teammate with working/idle/failed status; one transcript viewed at a time (arrows + Enter), Esc interrupts, `x` stops, Ctrl+T toggles a shared task list; idle rows hide 30 s after the panel goes idle and beyond three collapse into "N idle agents". Seeing all outputs at once needs tmux/iTerm2 split panes. Scoped to one session's teammates, not independent sessions. No published evidence it improves supervision — a design precedent, not a result.
Sources: /agent-teams §Display modes, §Agent panel · issues #79016, #27639, #29271

**F9 — Claude Code on the web's session list.** *high, 3-0.* Sidebar of sessions, each with a `+42 -18` diff indicator that opens a diff view with inline comments sent to Claude on the next message; archive/delete/share; an "expired" marker when the VM is reclaimed; history restored on reopen but running background work is lost. Research preview.
Sources: /claude-code-on-the-web §Review changes, §Archive, §Environment expired · issue #50197

**F10 — Sandboxing is orthogonal.** *high, 3-0 ×8.* "The sandboxed Bash tool … restricts only Bash commands. Built-in file tools, MCP servers, and hooks still run directly on your host." `@anthropic-ai/sandbox-runtime` (beta) wraps the whole process, denies network by default, scopes writes via `filesystem.allowWrite/denyWrite/allowRead/denyRead` — so per-session write-scoping to a worktree path is expressible. "Effective sandboxing requires both filesystem and network isolation." Admitted weaknesses: userspace domain proxy without TLS inspection (fronting), `~/.ssh`/`~/.aws` readable unless denied, escape hatches, Docker socket = host access, Linux deny-list built once at launch, `sandbox-exec` deprecated, CVE-2026-39861 symlink reports. **No sandbox option addresses two sessions sharing one working tree** (issue #34370, closed duplicate).
Sources: anthropic.com/engineering/claude-code-sandboxing · /sandboxing · /sandbox-environments · github.com/anthropics/sandbox-runtime · /agent-sdk/secure-deployment

**F11 — Cloud sessions.** *high, 3-0 ×2.* Each session in its own Anthropic-managed VM, network limited by default, credentials behind an authenticating proxy; independent sessions monitored via `/tasks`; no documented concurrency cap and no separate compute charge (rate limits consumed proportionately). But: the VM clones the *GitHub remote at your branch*, not your checkout — push first; a non-GitHub repo gets a bundled local copy that cannot push back; with network off the session still reaches the Anthropic API. An undocumented local burst limit exists (issue #53922: ~3–4 of 10 rapid local sessions started).
Sources: /claude-code-on-the-web · /cloud-environments · issue #53922

**F12 — Evidence-ranked isolation ladder.** *derived.* See table below.

**F13 — Recommendations.** *medium, derived.* See below; inferences from documented behaviour, not measured.

## The isolation ladder, ranked by evidence

| Rung | What it is | What is documented | Cost / limits | Where MARVIN stands |
|---|---|---|---|---|
| 1 | **Shared tree + visibility** | No isolation of any kind. Anthropic's only mitigation: partition file ownership and stay mutually aware. | Free. Collisions are the expected outcome. | **Today.** ADR-0102's HEAD-moving confirm is a visibility mechanism on this rung. |
| 2 | **Per-session worktree** | Documented, harness-enforced ≥ v2.1.218, the desktop app's own default. | Fresh checkout: `.env`, deps, Maven/node_modules per worktree; branches from remote default unless `baseRef: head`; shared `.git` and permissions; a merge step back. | Partly built for *implementers* (ADR-0081/0103: `worktree_create/list/merge/remove/sweep`), not for chat sessions. |
| 3 | **Worktree + sandbox-runtime** | Adds host/credential/network containment for auto-approved or unattended sessions. | Beta config; sidecar must launch through `srt`; adds no conflict prevention. | Not used. |
| 4 | **Cloud VM** | Strongest isolation, independent sessions, `/tasks` monitoring. | Decoupled from local checkout; GitHub-centric; GitLab fallback cannot push back; research preview. | Not applicable to the GitLab monorepo today. |

Sessions, forks and checkpoints are not on the ladder.

## What MARVIN already has, mapped

- **ADR-0081 + ADR-0103** built rung 2 for *subagent implementers*: `worktree_create` cuts `.marvin/worktrees/<slug>` from the current HEAD (this is `baseRef: head` semantics, which the docs say is *not* the CLI default), `reconcileWorktrees` derives `running | empty | ready | merged` from git, `worktree_merge` merges locally and never pushes (measured: a GitLab `main` pipeline costs 20–28 min of a paid 2× runner, so batching merges matters), `worktree_sweep` reclaims empty and merged trees. **This is the machinery a per-tab worktree needs; it is simply not wired to chat sessions.**
- **ADR-0102** chose rung 1 with visibility for human-steered sessions, citing Anthropic's agent-teams precedent of partitioned ownership. The research confirms that precedent — and also that Anthropic's *desktop* product chose rung 2 for the same scenario.
- **The plan spine per session** (ADR-0046/0049/0052/0106) already gives each tab a plan/todo strip; a watch UI can surface it per row without new state.

## Recommendations for MARVIN

Ordered by leverage. Everything here is derived from documented behaviour; nothing has a measured effect size.

1. **Make "worktree per tab" a first-class session mode, default for a second concurrent tab on the same project.** Reuse `worktree_create`; set the SDK setting `worktree.baseRef: "head"` so the tab starts from the user's branch (the docs' default `fresh` would silently drop unpushed work). Pin the bundled CLI ≥ 2.1.218 (SDK 0.3.251 already satisfies this) so the four isolation checks apply, and ship them to every subagent the tab spawns.
2. **Amortise the fresh-checkout cost with the SDK's own knobs**, which exist for exactly this: `worktree.symlinkDirectories: ["node_modules", ".cache"]` (nothing is symlinked by default), `worktree.sparsePaths` for a monorepo tab that only touches `apps/web`, a `.worktreeinclude` for `.env`-style files, and a `WorktreeCreate` hook for the Maven offline repo and Testcontainers image reuse (note: a hook that replaces git logic disables `.worktreeinclude`).
3. **Keep the shared-tree mode, but make its ownership explicit.** Anthropic offers no enforcement on rung 1; MARVIN can: a per-tab ownership manifest (paths the tab may edit) and a pre-tool hook that refuses Edit/Write and `git checkout|switch|rebase|reset` outside those paths, extending ADR-0102's confirm from "HEAD-moving commands" to "edits outside your lane".
4. **Resume by id, never `continue: true`.** MARVIN already stores `marvinSessionId` and the SDK id in the transcript; keep that the only path and never fall back to "most recent session in cwd".
5. **Build the multi-session strip on supported calls, not transcript scraping.** Live state from each session's `query()` stream (already flowing through the turn registry); history and identity from `listSessions({dir, includeWorktrees: true})`, `getSessionInfo`, `renameSession`, `tagSession` (a tag can carry the worktree name). Do not parse `~/.claude/projects/*.jsonl` directly — the format is declared unstable.
6. **Per-session row, in this order of importance:** state (working / idle / awaiting-permission / failed — the agent panel's vocabulary), the attention signal (a pending confirm or AskUserQuestion, routed to the tab that asked, with a warning that an "always allow" grant is repo-wide), branch/worktree name, a `+N −M` diff badge that opens a diff view whose inline comments feed the next prompt (the web UI's pattern), the plan strip's `done/total`, and cost from the result message. Collapse idle rows after a timeout the way the agent panel does, and show one transcript at a time — Anthropic's two UIs both do, and no evidence exists that simultaneous transcripts help.
7. **Reserve sandbox-runtime for auto-approve or unattended tabs** (wakeup-driven work, implementers), scoped with `filesystem.allowWrite` to the tab's worktree, and only after also denying `~/.ssh`/`~/.aws` reads. Do not present it as conflict prevention.
8. **Cloud sessions are a side-quest tool**, useful for a GitHub-hosted repo, not for the GitLab monorepo until the fallback can push.
9. **Watch the local burst limit** when launching several sessions at once (issue #53922); stagger session starts by a second or two.

## What this research could not establish

- **No measured conflict rates, throughput, cost or error-amplification numbers.** 120 claims were extracted; the verification budget covered 25, all Anthropic primary. Sources from the other angles were fetched (OpenAI Codex environments, Conductor, Claude Squad, Vibe Kanban, four arXiv papers from 2025–26, five practitioner blogs on parallel sessions and worktree runtime isolation) but their claims were dropped at the budget cap, **not refuted**. Nothing here says they are wrong; it says they are unverified. A follow-up run scoped to angles 2–4 only would close that gap.
- **Vendor docs describe intended behaviour.** No independent test of the four worktree checks was found.
- **Version sensitivity.** Enforcement (v2.1.203/210/218), permission sharing (v2.1.211), prompt surfacing (v2.1.186), idle rows (v2.1.181/199), `/tasks` display (v2.1.242) all moved within 2026; issues #55708, #76197 (open), #39886 straddle those fixes.
- **Three products are previews** (sandbox-runtime, Claude Code on the web, agent teams); config and limits may shift.
- **Two findings passed 2-1** (F5, F8).
- **GitLab.** Cloud-session guidance is GitHub-centric; the documented fallback for other hosts bundles a local copy and cannot push back.
- **"Sandboxed" is not a complete boundary** given the admitted weaknesses in F10.

## Open questions

1. Measured merge-conflict rates and merge-back cost for 2–3 human-steered sessions in separate worktrees of this monorepo versus a shared tree with partitioned ownership.
2. The exact SDK path for a sidecar to create and enter a worktree for a `query()` session (the `worktree` settings block and `EnterWorktree` exist in `sdk.d.ts` 0.3.251; whether `resume` returns an SDK session to its worktree as reliably as the CLI docs state needs a test).
3. Per-worktree setup cost here: Maven local-repo sharing, `node_modules` strategy, Testcontainers/PostGIS image reuse; whether `symlinkDirectories` + a `WorktreeCreate` hook amortise it.
4. Whether any third-party manager publishes evidence that specific per-session signals change supervisor outcomes, and what the local burst limit actually is.

## Sources fetched (24)

Primary (Anthropic): code.claude.com/docs/en/{worktrees, agent-teams, sessions, sub-agents, sandbox-environments, claude-code-on-the-web}; platform.claude.com/docs/en/agent-sdk/sessions; platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes; anthropic.com/engineering/claude-code-sandboxing; github.com/anthropic-experimental/sandbox-runtime.
Primary (other, fetched but not verified within budget): developers.openai.com/codex/cloud/environments; github.com/smtg-ai/claude-squad; github.com/BloopAI/vibe-kanban; arxiv.org/abs/2607.04697, 2605.20563, 2512.08296, 2608.18092.
Secondary / forum / blog (fetched, not verified): docs.conductor.build; anthropics/claude-code issues #60295, #55724; readysolutions.ai (parallel sessions, one repo); penligent.ai (worktrees need runtime isolation); trigger.dev (parallel agents with GitButler); cloudzero.com (Claude Code agents cost).

Run record: `~/.claude/projects/-Users-robertilisei-Projects-agri-saas-platform/453cc578-…/subagents/workflows/wf_0eb3450c-9e3/journal.jsonl`.
