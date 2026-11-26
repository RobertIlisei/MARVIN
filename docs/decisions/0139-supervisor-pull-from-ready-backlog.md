# ADR-0139 — The supervisor pulls the next ready backlog item, under a policy the owner sets once

- **Status:** Proposed (2026-11-27). The owner approves it before anything is built.
- **Amends:** [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) §4 item 7 (a tab opens only on the user's word, through a confirmed card) and the Golden Rule 1 line "a model never opens a session on its own initiative". This ADR is that widening.
- **Narrows:** [ADR-0113](./0113-the-backlog-is-the-shared-task-list.md) for tabs the supervisor pulled (§2). Tabs the user opened claim as before.
- **Related:** [ADR-0044](./0044-project-backlog.md), [ADR-0047](./0047-backlog-capture-at-discovery.md), [ADR-0128](./0128-the-user-talks-to-the-supervisor.md), [ADR-0137](./0137-the-backlog-is-checked-when-a-tab-closes-its-scope.md), [ADR-0122](./0122-a-tab-gets-its-worktree-or-is-refused.md).

## Context

On 2026-11-27 the owner asked whether tabs could claim tasks from the list themselves, "implemented in a way together with the supervisor". The supervisor proposed, and the owner answered "yes":

> "yes to the idea, but the supervisor does the taking, never the tab. … What I'd build instead, the 'supervisor pull': 1. A 'ready' state in the backlog: groomed, with a brief, and no dependency on you or an authority. 2. My dispatcher takes the next ready item itself, by your priority rules, when a slot frees. No brief from me needed per item, so the queue never runs dry overnight. 3. The supervisor marks the claim, not the tab. A tab still gets one bounded item and can't pick another. 4. You set the rules once: priorities, what's excluded (release freeze, gate changes), and the daily cap. Everything stays in the ledger you can read. … It widens what the supervisor does in MARVIN, so by MARVIN's own rules it needs a short decision record first."

Measured on the real project, 2026-11-26: 23 next-release merges in a day, all from supervisor-written briefs; the start queue ran empty several times; a release fix waited 30 minutes for a start slot behind idle next-release tabs. Today's dispatcher is a script beside an external Claude Code session (a text queue, tab caps, host checks, a pause file) with no policy or ledger MARVIN can read.

The 2026-11-27 research rejected two shapes, and this ADR keeps both rejections: **agents claiming from the list themselves**, and **an agent closing items on its own**. ADR-0127 already lets the supervisor open a tab, but only for a request the user made, behind a card showing first message, tree and posture.

## Decision

**A backlog item can be `ready`. When a slot frees, the runtime behind the supervisor starts one tab for the highest-ranked ready item the owner's policy allows, records the claim on the item, and ledgers the pull. The owner writes the policy once. A tab never picks, claims or starts anything.**

### 1. The `ready` state

- **Who sets it:** the owner, or the supervisor through a `mark_ready` verb with grounds. Never a tab: a tab's attempt is refused. The policy's `readyBy` says who counts; it ships as `["owner"]`, and adding `"supervisor"` is the owner's switch once the ledger shows its proposals were right.
- **What an item needs**, checked when marked and again at pull time:
  1. status `open` (not provisional, not `doing`);
  2. a brief: the machine-filed template (why, where as `file:line`, evidence, how to verify, out of scope) or a readable `brief` path;
  3. `waitsOn` empty: a person, an authority or free text blocks; a slug blocks until that item is done;
  4. a `release` and a `priority`;
  5. the size of one tab: a body under the cap, not a list of independent changes;
  6. no boundary path (ADR-0104's list) unless the policy allows it. Default: excluded.
- **How it leaves ready:** claimed (§2), or un-readied with a reason by the owner, the supervisor, or the pull's own recheck. An item failing the recheck is un-readied and ledgered, never started.

### 2. The pull

- **Trigger and choice are code.** A slot frees on turn end, tab close or merge, or when the policy's hours open. The runtime ranks eligible items by the policy's order (priority, release order, age, slug) and takes the first. The supervisor's model neither chooses nor writes a per-item brief.
- **The start is the existing `new_session` path.** The first message is the item's brief inside a fixed envelope naming the item and what a supervisor message cannot authorise. The tree is a fresh worktree through ADR-0122's atomic path. The posture is the policy's, never wider. The turn is recorded `author: "supervisor"`, `origin: "pull"`, and is supervisor-touched (ADR-0127 §5), so every human-only act inside it needs the user.
- **One item, one tab.** No splitting, and no second item for a tab.
- **The supervisor writes the claim:** `claimedBy` (session id), `claimedBranch`, `claimedAt`, `claimedVia: pull`, plus the ledger id. A pulled tab's `backlog_claim` on any other item is refused.
- **A tab that ends unfinished** (stopped, failed, closed unmerged) releases the claim to `open`, not ready, with a dated note. The supervisor may re-ready it after reading why; after two pulls only the owner can.
- **A refused start** (disk floor, worktree failure) skips the item, is ledgered, and backs off.

### 3. The owner's policy

One file, `<MARVIN_DATA_DIR>/supervisor/<projectId>/pull-policy.json`. Not the project's `.marvin/`: a repository must not grant its own supervisor a standing authority (ADR-0127 §3; `REVIEW.md`, project-controlled config). It is read at boot and on an explicit token-guarded reload, validated against a closed schema (an unknown key or bad value refuses the whole file and turns the pull off), and a tab's gate denies it.

It holds: `enabled` (default `false`); priority order; release rules (frozen releases excluded, a cap on release lines in work at once); excluded tags (gate changes stay held); caps per resource for items that declare `needs` (the capture lane, when saturated); live-tab and working-tab caps; a daily pull cap; hours; posture and delegation for pulled tabs (delegation at most `answer-questions` unless the owner writes more); `readyBy`. Every ledger line carries the policy's digest, so a change is visible afterwards.

### 4. Human-only, and what the pull never does

Human-only, as ADR-0127 §4: merging, pushing, merge requests, metered CI, tags, deploys, production, widening a posture, approving a plan, changing scope, discarding work. A pulled tab asks the user for each, in every posture.

The pull never lets a tab pick or claim its next item, set `ready`, or start anything; never lets a model spawned by a tab start anything; never starts two tabs for one item or a tab in a shared checkout; never closes an item. Closing stays derived from git (a `Backlog: <slug>` trailer reachable from the integration branch) or is done by the owner or supervisor with evidence. A pulled tab's resolve is a proposal: the item stays `doing`, shown as "done, waiting to merge", until git or a person confirms it.

### 5. Why this does not break Golden Rule 1

The banned shape is a model dispatching models on shared state with no human between. Here one supervisor starts every tab under a human-set policy; each tab has its own worktree and one bounded item; no tab starts another; a human merges; every pull is a ledger line the auditor reviews. It does widen ADR-0127: until now a model never opened a tab without a confirmed card, and here the owner's standing policy replaces that card, within its caps. Being a widening, it ships off, then shadow (pulls proposed and ledgered, not performed), then on, as ADR-0127 §8 requires.

## Consequences

- The queue no longer depends on the supervisor being awake and writing briefs.
- A bad ready item can run for hours unread. Brakes: the recheck, the size cap, the daily cap, supervisor-touched gates, the kill switch.
- Brief text becomes a tab's first message, so it is project-controlled input: the envelope makes it the task, never authority.

## Alternatives considered

- **Tabs claim from the list (agent-teams style).** No human between; breaks the parking-lot rule.
- **A brief per item from the supervisor.** The bottleneck that emptied the queue.
- **Policy in `.marvin/`.** A cloned repository could enable its own pulls.
- **A confirmed card per pull.** What the dispatcher amounts to today; kept as the shadow stage.
- **An agent closes finished items.** Needs its own ADR.

## Open questions for the owner

1. Does the supervisor mark items ready from day one, or only you until shadow numbers exist?
2. Host pressure (load, memory, swap), checked by the script today: policy keys, or only ADR-0122's disk floor?
3. Is "the two-lines rule" a cap on release lines in work at once?
4. May a pulled tab still call `backlog_resolve` as ADR-0137 has it, or only propose?

## Measures, after two weeks

Minutes the queue was empty while ready items existed (target zero); start wait for release items; merges per day; items reopened after done; items un-readied by recheck; owner overrides and pauses.

## Scope of Done

- [ ] `ready` and `readyReason` are in the item schema, settable only by owner or supervisor; a tab's attempt is refused (test).
- [ ] The selector returns the same item for the same backlog and policy, honours every exclusion, never returns an item failing the recheck (table test).
- [ ] A pull starts one tab in a fresh worktree at no more than the policy posture, the supervisor writes the claim, the ledger line carries the policy digest; a pulled tab's claim on another item is refused.
- [ ] A missing, invalid or project-located policy means no pull; an unfinished tab releases its claim to `open` with a note.
- [ ] The kill switch and daily cap stop pulls within one wake; a pull performs no human-only act.
- [ ] `AGENTS.md` Golden Rule 1 and ADR-0127 point here; the roadmap lists the pull as in flight.

## Related

The backlog work in flight on a parallel branch builds `release`, `waitsOn`, `priority`, derived done from git, and the open index plus archive. This ADR depends on `release` and `waitsOn` from it and adds `ready` to the same schema change. Research: `backlog-practices-2026-11-27`, "Rejected" list.
