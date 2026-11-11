# ADR-0131 — A project notice reaches running tabs without a message to each

- **Status:** Accepted (2026-11-11), with the amendments under "Decisions" below; build plan in [`docs/plans/supervision-improvements.md`](../plans/supervision-improvements.md)
- **Related:** [ADR-0118](./0118-one-prompt-per-session-and-settings-isolation.md) (per-turn values ride the reminder suffix), [ADR-0110](./0110-worktrees-isolate-the-filesystem-not-the-machine.md) (tabs share a machine), [ADR-0127](./0127-a-supervisor-session-oversees-the-tabs.md) (`send_message`)
- **Evidence:** [`docs/reviews/2026-11-11-supervising-marvin-field-notes.md`](../reviews/2026-11-11-supervising-marvin-field-notes.md)

## Context

Tabs share a machine (ADR-0110) and a project that changes under them. Over 2026-11-09 → 11 the supervisor told running tabs a fact about twenty times: the test machine is unreachable; it is back at a new address; the screenshot config moved to one file per project; append-only release files are now union-merged. Each time that was one message per open tab. A message is a turn: it costs tokens, it interrupts or queues behind the live turn (`202`), and a tab that opens ten minutes later never hears it.

The instruction files (ADR-0119) are the wrong place: they are the system prompt, built once per session and replayed (ADR-0118), so a change reaches only new tabs.

## Decision

**A project has a short list of dated notices; every turn of every tab in that project carries the current ones in its reminder suffix.**

1. **Store.** `<workDir>/.marvin/notices.json`: `[{ id, text, createdAt, expiresAt, author: "user" | "supervisor" }]`. At most 8 live notices, each at most 400 characters, each with an expiry (default 24 h, at most 7 days). Read at a validating boundary: the file is in the user's repository, so its text is attacker-controlled input (the project-controlled-config rule in `REVIEW.md`): plain text only, length-capped, rendered inside a labelled block that says it is information about the environment, not an instruction to change scope.
2. **Delivery.** `turnReminders` appends a `Project notices` block when live notices exist. It is per-turn text in the suffix, so the system prompt and its cache are untouched (ADR-0118). A tab sees a notice on its next turn, whatever starts that turn; no turn is started to deliver one.
3. **Writers.** The user, from the Sessions pane ("Tell every tab…"), and a supervisor through a new policy-checked verb `post_notice`, delegable under `answer-questions`, ledgered like any act. A tab cannot write notices (the store is behind the same gate deny as `.marvin/plans/`).
4. **A notice is never consent and never a scope change.** The block's label says so, and the policy refuses a supervisor notice that names a human-only act (the same word list `send_message` uses).

## Consequences

- One write replaces N messages and N turns, and late tabs are covered.
- A waiting tab does not learn a fact until its job finishes. That is right for "the config moved"; for "your job's machine is gone" the job's own failure already wakes it.
- One more block in the suffix: bounded at 8 × 400 characters.

## Alternatives considered

- **Broadcast `send_message`.** What was done by hand; N turns, and nothing for tabs opened later.
- **Edit the project's instruction file.** Reaches new sessions only, and puts a two-hour fact in a durable document.
- **Memory (`remember`).** Durable facts only (ADR-0042); a notice is the opposite.

## Open questions (recommended answer first)

1. May the supervisor post without the user's click? **Yes, under `answer-questions`**: it is the same authority as telling one tab, made cheaper.
2. Should a notice wake waiting tabs? **No.**
3. Expiry required? **Yes**: an unexpired stale fact is worse than none.

## Decisions (2026-11-11, by the owner's delegation, after checking the text against the code)

The three open questions are answered as recommended. Three amendments:

1. **A supervisor notice that matches the word list becomes a card, and that is accepted.** The list is `questionHeuristic` (`supervisor-policy.ts`), the one the `send` verb uses. It matches "release", "merge", "production", "CI" and "token", so one of the field notes' own notices ("append-only release files are now union-merged") would not post on the supervisor's authority. A notice reaches every tab, which is wider than one message, so the list is not narrowed: the match raises an inbox card and the user's click posts it. The user's own notices are not checked against the list.
2. **`post_notice` is project-wide, so its delegation test is project-wide.** It is allowed when the supervisor is on and at least one open tab is delegated at `answer-questions` or above, and it follows the `nudges` autonomy category: in shadow it proposes a card.
3. **The gate deny covers shell writes too.** `.marvin/notices.json` joins the protected-path block that already covers `.marvin/memory.md` and `.marvin/plans/` (Edit, Write and a mutating Bash command that names the path), and the notices route joins the control routes a tab cannot reach.

## Scope of Done

- [ ] The store validates at the read boundary; over-long, expired and malformed entries are dropped (tests).
- [ ] A live notice appears in the reminder suffix of the next turn of two different tabs and in the first turn of a tab opened afterwards; the system prompt bytes are unchanged (test against `buildTurnSystemPrompt`).
- [ ] `post_notice` is refused for a human-only act and ledgered when allowed; a tab's write to the store is denied at the gate.
- [ ] The Sessions pane can post and retire a notice.
