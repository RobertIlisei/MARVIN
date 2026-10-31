# Supervisor surface — design brief

- **Status:** shaped 2026-10-30 (Impeccable `shape`). No code. This brief is the input to ADR-0127 plan milestone 6, and its field list (§10) is the contract the sidecar milestones 1–5 should match.
- **Decision record:** [ADR-0127](../decisions/0127-a-supervisor-session-oversees-the-tabs.md) (on `marvin/tab/supervisor` at the time of writing), plan `docs/plans/supervisor.md` milestone 6.
- **Visual authority:** `DESIGN.md`, "The Quiet Instrument". This brief **extends the Sessions pane**. It adds no new visual world, no new colour, no new radius and no new component family. It builds from the ADR-0114 pane vocabulary (`PaneHeader`, `PaneSectionHeader`, `paneRow`, chips, `paneIconButton`, `PaneEnableToggle`, `PaneNoticeStrip`, `PaneEmptyView`) and from the native controls. `DESIGN.md` is not changed by it.
- **Mode:** Operate. Ambition shows as precision and restraint, not expression.
- **Discovery answers** (2026-10-30, given by Robert's supervisor session; all four took the recommended option):
  1. **Needs you is the inbox.** Escalations grow the tab rows that already sit in *Needs you*. There is no second inbox.
  2. **Outward acts expand first.** Reversible acts take one click. An act that leaves the machine or destroys work shows its act chip only once the item is expanded to the full raw act. No Return or default binding ever gives consent.
  3. **Transcript: an outlined bubble, with no new hue.**
  4. **Off state: one quiet line at the bottom** of the pane.
- **Provenance:** derived from source and the ADR. Nothing was rendered, because this Mac has no Swift 6.1 toolchain. Point sizes and widths below are taken from the existing components (`file:line` where cited). The milestone 6 build verifies them in the snapshot harness at 260 and 420 pt.

---

## 1. Job and audience

**Who.** Robert, or any MARVIN user who runs several chat tabs on one project, each in its own worktree. They have switched on a model that watches those tabs. They look at the Sessions pane in passing, between their own work, at 260–420 pt wide.

**What they need from it, in order:**

1. **What needs me, and is it safe to say yes?** For each escalation, they need the raw act, the supervisor's recommendation and the grounds for it, in that order.
2. **Is the supervisor alive, and what is it allowed to do?** That means its mode, its health, its budget, and the delegation level on each tab.
3. **What did it do while I wasn't looking?** That is the ledger.
4. **Stop it, now.** That is Pause and Kill.

**State of mind.** The user is busy elsewhere and comes back to a queue. The risk is not confusion but rubber-stamping, because a fluent recommendation invites a click. The surface's job is to make the user's consent land on *the act* and not on *the supervisor's description of it* (ADR-0127 §5).

## 2. Outcome and proof

The surface succeeds when all of these hold:

- **A glance answers it.** From the Sessions pane alone, the user can answer: is the supervisor on, in which mode, healthy, and within budget?
- **Consent is on the raw act.** Every escalation can be judged and decided without leaving the pane. The consent control is labelled with the act it performs ("Allow push", "Open tab", "Merge"), never "Accept".
- **The supervisor is never mistaken for the user.** No supervisor message, answer or act can be confused with the user's in the pane, the transcript or VoiceOver. Shape, label and glyph carry the difference, with no colour required.
- **It works without a pointer.** Every control is reachable and operable from the keyboard and VoiceOver. Every arrival of an escalation is announced. (The audit scored Accessibility 1/4 and found 5 `accessibilityLabel`s in the whole app; this surface ships with its own.)
- **Pause and Kill are fast.** Both are one action away at all times, from the pane and from the command registry.

**The product truth the surface rests on.** The recommendation is advice. The click on the raw act is the consent. Everything about the inbox item's order follows from that.

## 3. Direction

**Thesis: *Needs you is the inbox. The act leads, the advice follows, the grounds are one disclosure away.***

The category default is an "AI inbox": cards whose headline is the agent's summary, with an Approve button. This surface refuses it. The headline of an escalation is a deterministic description of the act, built from the tool and its input by the server, never written by the supervisor. The supervisor's recommendation comes second, under its own glyph.

**Structural consequences:**

- **No new section for the inbox.** *Needs you* is where an escalation already belongs, and it already holds the tab's inline confirm (`SessionsPane.swift:433-436`, `:491-518`). The supervisor adds a recommendation and grounds to that row, and the pending confirm is never shown twice.
- **Tabless items are rows too.** A new-tab proposal, budget reached, a nudge cap or a breaker trip is a row in *Needs you* whose subject is the supervisor itself.
- **The supervisor's own chrome is two thin pieces:**
  - a **status strip** under the pane header while it is enabled;
  - a collapsed **Supervisor log** section at the bottom.

  When it is off, it is a single line below History.
- **One mark, everywhere.** The supervisor is identified by one SF Symbol, `binoculars` (SF Symbols 2, available on macOS 14), and the word "supervisor" in SF Mono. It appears in the strip, on inbox items, in the ledger, on the delegation chip menu and in the transcript. No hue is reserved for it (DESIGN.md's One Accent Rule).

## 4. Scope and boundaries

**In scope (milestone 6):**

- the status strip and its expanded settings block;
- the set-up sheet;
- the off line;
- escalation cards inside *Needs you* rows;
- supervisor rows in *Needs you*;
- the shadow "would answer" line;
- the per-tab delegation chip;
- the Supervisor log section;
- transcript marking (messages, answers, the touched-turn divider);
- the `supervisor` role row in the Models dialog's Helpers section;
- registry commands.

**Untouched:**

- the existing section order and behaviour of Working, Ready to integrate, Idle and History;
- the tray confirm card;
- AskQuestionSheet's form;
- DESIGN.md tokens;
- the rail.

**Anti-goals.** Each would make the result wrong even if it looked polished:

- **A batch "Accept all" or "Approve all", in any state.** Consent is per raw act.
- **The supervisor's prose as an item's headline,** or a consent button labelled "Accept" or "Approve recommendation".
- **The supervisor drawn as the user,** on the right with an inset fill, or labelled "you".
- **A new colour, shadow or material for the supervisor,** or a dashboard of charts. Agreement numbers are text.
- **A height animation, `GeometryReader` or `.textSelection` inside the pane** (ADR-0114 constraints, ADR-0062).
- **Return as the default action on any consent chip** (audit W2, C8).
- **Layout that changes by measured width.** One layout serves 260 and 420 pt, by rule (ADR-0114, `PaneHeaderOverflow`).

## 5. Layout and placement

**Pane order with the supervisor enabled:**

```
SESSIONS                                [+] [↻]      ← PaneHeader (unchanged)
▣ Supervisor · Shadow           [⏸] [⋯]  [›]         ← status strip, line 1
━━━━━━━━━━──────── $3.20 / $10 · watching 4           ← status strip, line 2
NEEDS YOU  5                                          ← section; inbox lives here
  ▣ Supervisor — Open a new tab …                     ← tabless supervisor row
  ✋ fix-flags  …  [◉]  [Answer]                      ← tab row, with delegation chip
     └ escalation card (raw act · recommendation · grounds · act chips)
WORKING 2 / READY TO INTEGRATE / IDLE / HISTORY       ← unchanged
SUPERVISOR LOG  38 today  ›                           ← collapsed section
```

**Pane order with it off:** everything as today, then one line under History:

`▣ Supervisor · off  [Set up…]`

**Widths.** The pane has 12 pt horizontal padding and rows 14 pt (`SessionsPane.swift:70,438`). That leaves about 208 pt inside a row at 260, and about 368 pt at 420. An escalation card nested in a row adds 8 pt padding, leaving about 190 pt at 260 — roughly 28 characters of 11 pt SF Mono per line. The rules follow from that:

- **The act chips sit on their own line** under the card's content, leading-aligned, at every width. They never share a line with text, so 260 pt needs no wrapping logic and 420 pt simply has air.
- **Raw-act text shows 3 lines,** then "Show full act". Recommendation and reason show 2 lines, then expand.
- **Every row and card keeps `minWidth: 0`** and `Spacer(minLength: 0)`, and truncates with `.middle` for paths and branch names and `.tail` for prose.
- **The status strip's line 2 truncates from the tail.** Budget comes first, so it survives at 260.

**Heights.**

- The strip is about 40 pt: two lines at 11 and 10.5 pt plus a 4 pt meter.
- A collapsed escalation card is about 90–110 pt.
- The off line is about 22 pt.
- The log section is about 22 pt collapsed.

Expansion inserts content without animation, or with an opacity fade under Reduce Motion off. Never with a height transition.

## 6. Hierarchy of each element

### 6.1 Status strip (enabled)

**Line 1, in reading order:**

1. the `binoculars` glyph, 11 pt medium, in `textMuted`;
2. "Supervisor", 11 pt semibold, `textPrimary`;
3. a mode label, 10.5 pt `textMuted` — "Shadow", "Autonomous · 2 of 4", "Paused", "Waking · 3 items" — with a state glyph wherever the state is not neutral (§7);
4. `Spacer(minLength: 0)`;
5. Pause/Resume, a `paneIconButton` (`pause.fill` / `play.fill`);
6. a **Kill** chip, `.rowChip(.tinted(red))` with the `stop.fill` glyph, **only while a wake is in flight**. When idle, Kill and Pause do the same thing, so Kill lives in the ⋯ menu;
7. the ⋯ menu: Kill, Settings…, Charter…, Disable supervisor…;
8. a disclosure chevron.

**Line 2:**

1. the budget meter: a 4 pt bar, the whole strip width minus its text, radius 3 (badge). Its fill is `textMuted` below 80 %, orange from 80 %, and red at the cap, where the cap also gets the `exclamationmark.triangle.fill` glyph;
2. "$3.20 / $10" in 10.5 pt SF Mono with monospaced digits;
3. "· watching 4 · woke 2m ago" in 10.5 pt `textMuted`, tail-truncated.

**Expanded block** (the chevron opens it in place):

- **Autonomy.** Four rows: Questions, Nudges, Posture, Confirms. Each row has a `PaneEnableToggle` with its accessible name ("Questions autonomy"), the category name, and a stats line in 11 pt `.secondary`: "16 proposals · 94 % agreed · bar 20 / 90 %". Below the bar, the line reads "below suggested bar". If a human-only act was ever proposed as `act`, the row shows a warning glyph and "proposed a human-only act 1×". The bar is shown and never enforced (ADR-0127 §8). Confirms is disabled, with the reason, until at least one tab is at `answer-confirms`.
- **Charter.** Its first 2 lines, then an "Edit…" chip that opens a sheet with a multi-line field.
- **Daily cap.** A stepper with a field, in USD. Raising it is the user's act, and it applies at once.
- **Model.** A read-only label (role resolved model) with a "Change…" chip that opens the Models dialog scrolled to Helpers.
- **Disable supervisor…** A neutral chip that opens a `confirmationDialog` with Cancel as the default. Disabling stops the loop and keeps the ledger.

### 6.2 Escalation card (inside a *Needs you* tab row)

It is an `elevated` fill with radius 6 (card), 8 pt padding and a 1 pt hairline. It sits under the tab row's line, indented 16 pt like today's inline confirm (`SessionsPane.swift:516`). It **replaces** the inline confirm for that pending item, so there is never a duplicate. Top to bottom:

1. **Why it is here.** One line, 10.5 pt medium: a kind glyph plus a server-written reason label.
   - Human-only acts read "Only you can push", "Only you can merge into development", and so on, in `textPrimary`.
   - Other escalations name the gap: "Supervisor unsure — weak grounds", "Question names an act: merge" (with "heuristic" in muted mono), "Third nudge on step [3]".
   - In shadow, a non-human-only item reads "Shadow — the supervisor only proposes".
2. **The raw act.** This leads the card.
   - A mono badge with the tool name (10.5 pt, `orange.opacity(0.16)` fill, radius 3 — the existing confirm badge, `ConfirmSheet.swift:406-410`), then a server-built plain summary at 11 pt `textPrimary`, 3 lines max. For example: "git push origin marvin/tab/fix-flags", "Merge marvin/tab/x into development", "Edit .env.local (+2 −0)".
   - A merge adds the preview line: "clean · +120 −8" / "behind by 2" / "conflicts in a.ts, b.ts" (orange glyph).
   - A boundary path lists the paths.
   - "Show full act" expands to the complete input in 10.5 pt SF Mono, wrapped, with the digest at the end. This fixes audit L7: the decision is never taken on a one-line, middle-truncated excerpt.
3. **The recommendation.** The `binoculars` glyph, then "Supervisor recommends **Deny**" at 11 pt `.secondary` with the verb in semibold, then the supervisor's reason at 11 pt `.secondary`, 2 lines, with "more" to expand. It is visually subordinate to item 2: smaller weight, muted colour, below it.
4. **Grounds.** A disclosure, "Grounds · 2 (1 strong)". Opened, each ground is one row:
   - a provenance badge, `strong` or `weak`, in 10 pt mono on a radius-3 capsule. Weak is outlined, strong is filled with `rowSelected`, so the difference does not depend on colour;
   - the ground's label;
   - its citation as a link — `plan [3]`, `ADR-0107`, `charter`, `src/a.ts:42 (tab tree)`. Activating a link opens the plan, the ADR or the file at that line in the right tree.
   - A ground that failed to resolve shows a strike glyph and "did not resolve". Such an item is always an escalation.
5. **Act chips,** on their own line:
   - **Recommended act.** `.rowChip(.primary)` — one accent chip per group. Its label is the act verb from the server: "Deny", "Allow push", "Merge", "Answer: Option B".
   - **Counter act.** `.rowChip(.neutral)` — "Allow", "Deny", "Answer…".
   - **More (⋯).** A menu: "Open tab" (switch to it), "Answer differently…" (opens AskQuestionSheet), "Copy act", and "Dismiss" for tabless items only.
   - **Outward or destructive acts** — push, MR, metered CI, a drop with work, closing a tab that holds work. While the card is collapsed, the act chip is replaced by "Review act…". It expands the card, scrolls the full act into view and only then shows the act chip. No consent chip carries `.defaultAction` or a Return binding.

**Question escalations.** The raw act is the question text, 11 pt semibold, 3 lines. The recommended option's label and description follow in an outlined option box, then "+3 other options". The chips are "Answer: <label>" (primary) and "Answer…", which opens AskQuestionSheet with nothing pre-selected — the user chooses afresh. A multi-question ask shows "2 questions" and only "Answer…".

### 6.3 Supervisor row in *Needs you* (tabless items)

It has the shape of a tab row:

- the `binoculars` glyph at the state-glyph position;
- the title, 11 pt — "Supervisor";
- a subtitle, 10.5 pt `.secondary` (not `.tertiary`; audit L14) — "Open a new tab", "Daily cap reached", "Paused after 3 refused calls".

The card under it, by kind:

- **New tab** (ADR-0127 §4 item 7):
  - the first message, quoted: a 1 pt dashed leading rule and 11 pt prose, 4 lines then "Show all";
  - "Tree: fresh worktree from development @ 85a0492", 10.5 pt mono;
  - "Posture: gated · Plan · Sonnet 5.5 · medium" — each segment wider than the requesting tab's carries a glyph;
  - "Asked for by: your message, 14:02", a link into the supervisor conversation;
  - chips: "Open tab" (primary), "Edit…" (neutral; a sheet where the first message, base ref and posture can be changed — never widened past what the sheet shows), and ⋯ › Dismiss.
- **Guardrail** — budget reached, breaker, refusal pause, repeated failures, nudge cap:
  - the `PaneNoticeStrip` shape, with the warning or error kind, persistent;
  - its one verb chip: "Raise cap…", "Resume", or "Open tab".

### 6.4 Shadow "would answer" line (non-escalated items, shadow only)

When the supervisor is in shadow and has *proposed* an answer to a tab's pending question or ordinary confirm, the tab row's existing inline confirm stays exactly as it is, and the user answers it as today. Under it sits one 10.5 pt line:

"▣ Supervisor proposed an answer · Reveal"

The proposal is **blind by default.** Revealing it shows "would answer Option B" with its grounds disclosure, and the reveal is recorded (`proposalSeenBeforeAnswer`), so the agreement stats can separate blind agreement from anchored agreement. This keeps the shadow measurement (ADR-0127 §8) honest without hiding anything from a user who asks. *Default; see §10, open decision 1.*

### 6.5 Delegation chip (per tab)

- **Where.** A compact icon-only `Menu` on every tab row while the supervisor is enabled. It sits on line 1, trailing, before the action chip. It is about 18 × 16 pt with a padded hit area to 22 pt, using `paneIconButton` metrics.
- **Glyph per level** — a glyph, never only a colour:

  | Level | Glyph | Style |
  |---|---|---|
  | `off` | `circle.dashed` | muted |
  | `observe` | `eye` | |
  | `answer-questions` | `questionmark.bubble` | |
  | `answer-confirms` | `checkmark.shield` | `textPrimary` — the widest level reads strongest |

- **Menu items.** Four levels. Each has a checkmark on the current one and a one-line consequence as its subtitle:
  - "Not watched";
  - "Reads and escalates; never acts";
  - "Answers grounded questions, nudges inside the plan, narrows posture";
  - "Also allows or denies ordinary confirms. Never pushes, merges or touches boundary paths".

  A tab's "Delegation ▸" submenu also appears in the row's context menu.
- **Shared-checkout tabs** show the chip. The `observe` and wider items carry the note "Sends wait while another session works in this checkout".
- **Help text.** "Supervisor delegation: answer questions" plus the last act time.
- **Not shown** while the supervisor is off. Setting a level is the user's act and applies immediately; there is no confirmation dialog, because the user is setting the limit on the supervisor themselves.

### 6.6 Supervisor log (ledger) section

- **Header.** `PaneSectionHeader("Supervisor log", count: today's lines)`, collapsible, collapsed by default.
- **Opened.** A filter row of chips (All · Acts · Escalations · Refusals · Proposals) and an active tab filter when one is set ("fix-flags ✕"). Then the newest 20 rows, then "Show 50 earlier".
- **Row, collapsed (two lines):**
  - **Line 1:**
    - a decision glyph — never colour alone:

      | Decision | Glyph | Style |
      |---|---|---|
      | `act` | `checkmark.circle.fill` | |
      | `propose` | `circle.dashed` | |
      | `escalate` | `hand.raised.fill` | orange |
      | `refuse` | `xmark.octagon.fill` | |
      | `drop` | `minus.circle` | |
      | user or runtime events | `person.fill` / `gearshape` | muted |

    - the verb in 11 pt mono;
    - "·" and the tab's short name, middle-truncated;
    - trailing, the time as "14:02" in 10.5 pt mono `textMuted`.
  - **Line 2:** the reason, 11 pt `.secondary`, one line.
  - Shadow rows append "· you answered B ✓" or "✗" when paired.
- **Row, expanded.** The argument summary and digest (mono), the mode (shadow or autonomous), the wake id, grounds as in §6.2 item 4, the outcome and actual answerer, and a link to the inbox item or the tab.
- **Context menu.** "Show log for this tab", "Copy line as JSON", "Open tab".
- **Rotations** of the supervisor's session are rows of their own: "session rotated", `gearshape`.

### 6.7 Off line

- **Below History:** the `binoculars` glyph in `textMuted`, "Supervisor · off" at 11 pt `.secondary`, and a neutral chip "Set up…".
- **With no project open,** nothing is shown.
- **"Set up…" opens the set-up sheet,** a native sheet about 460 pt wide:
  - a two-sentence explanation: it watches the tabs you delegate, and starts in shadow, where it only proposes;
  - the charter, a multi-line field ("What should it know about your goals?");
  - the daily cap (default $20 — raised from $10 by the plan [7.1] measurement);
  - a checklist of open tabs to delegate, each with a level `Picker` (default `answer-questions`);
  - the model, as a label;
  - buttons "Cancel" (default) and "Start in shadow".

  There is no path to autonomy from this sheet.

### 6.8 Transcript marking

- **A supervisor-sent message.** Right-aligned like the user's, because it is input to the tab. **No fill.** A 1 pt **dashed** stroke in `textMuted` at about 0.6 opacity, solid 1 pt `textMuted` under Increase Contrast, with radius 12 and 12 × 8 padding (the user bubble's geometry, `ChatMessageRow.swift:113-124`).
  - **Label:** `binoculars` plus "SUPERVISOR" in caption2 mono, tracked 2, uppercase, in `textMuted` — not the accent, which belongs to "you".
  - **Footer** in caption `.secondary`: the kind ("nudge", "instruction", "first message") and "· grounds 2", which discloses the grounds list.
  - It is never rendered with the "you" label, whatever the transcript's `role` says.
- **A supervisor-given answer or decision.** The AskUserQuestion tool block, and any confirm decision line, gets an inline chip: `binoculars` "answered by supervisor" (or "allowed by" / "denied by"), in 10.5 pt `textMuted` with a hairline stroke and radius 5, with the grounds behind a disclosure. User answers carry no chip; absence means the user. Answers in shadow are never the supervisor's, so they get nothing.
- **The touched-turn divider.** When a turn becomes supervisor-touched (ADR-0127 §5), the transcript shows a full-width meta divider: a hairline, then caption `.secondary` text — "Supervisor touched this turn · pushes, merges and boundary edits now ask you, even in full auto". It is shown once per turn. This is the user's cue that the stricter gate is on.
- **The posture pill.** When the tab's posture was last set by the supervisor (`postureSource: "supervisor"`), the pill shows a 9 pt `binoculars` badge, and its help text reads "Narrowed by the supervisor at 14:02 — click to change".

### 6.9 Models dialog — Helpers

`TopBarPopovers.swift:601-616` already renders a role from `/api/models/roles` by its fields, so the `supervisor` role needs only its row from the server:

- **label:** "Supervisor";
- **description:** "Runs the project supervisor's wakes. Its spend counts against the supervisor's daily cap.";
- **default:** Sonnet tier.

The row's `Picker` must carry an accessible name ("Supervisor model"), which also fixes audit W4 for this row.

## 7. States

| State | Strip, line 1 | Strip, line 2 / body | Needs you | Controls |
|---|---|---|---|---|
| **No project** | — | — | — | Nothing rendered. |
| **Off** (default) | Strip absent. The off line sits below History (§6.7). | — | As today. | "Set up…" |
| **Set-up sheet open** | Unchanged | — | — | Cancel is the default; "Start in shadow". |
| **Enabled · shadow · idle** | `binoculars` "Supervisor · Shadow" | meter · watching N · woke Xm ago | The "would answer" line on items it proposed for (§6.4). Escalations as cards. | Pause, ⋯ |
| **Waking** | "Waking · 3 items", with a mini `ProgressView` in the glyph slot | unchanged | Unchanged until results land. | **Kill** chip appears; Pause stays. |
| **Autonomous** (some categories) | "Autonomous · 2 of 4" (a tooltip lists them) | unchanged | Autonomous acts do not appear here; they go to the log, and the tab's transcript shows the answered-by chip. | Pause, ⋯ |
| **Paused (by user)** | `pause.fill` "Paused" | "paused by you 14:02 · 3 events queued" | Escalations stay actionable; consent never depends on the supervisor running. | "Resume" (primary chip) replaces Pause. |
| **Killed** | `stop.fill` "Paused — wake aborted" | "Kill at 14:02 aborted a wake with 2 items" | Items from the aborted wake that were already ledgered stay. | "Resume" |
| **Over budget** | `exclamationmark.triangle.fill` "Paused — daily cap" | The meter is full in red with a glyph: "$10.00 / $10 · resets 00:00" | A guardrail row (§6.3) carries "Raise cap…". | "Raise cap…", Resume (disabled until the cap is above spend). |
| **Near budget** (≥ 80 %) | unchanged | The meter turns orange: "$8.40 / $10" | — | — |
| **Paused by breaker or refusals** | `exclamationmark.triangle.fill` "Paused — breaker" / "— 3 refused calls" | the reason | A guardrail row with "Resume" and "Open log". | Resume |
| **Empty inbox** | normal | "watching 4 · nothing for you" | Section hidden as today (no empty card). | — |
| **Burst** (many escalations) | "Supervisor · Shadow · 12 waiting" | normal | Per tab, the **oldest** escalation shows as a card and the rest collapse to "+3 more for this tab" (a neutral chip that expands in place). Guardrail rows sort first, then tabs by existing rank. Section header count = all items. | **No batch accept.** VoiceOver announces once ("12 escalations waiting"), not 12 times. |
| **Stale** (server says the loop has not woken while events are pending past the threshold) | `exclamationmark.triangle.fill` "Not waking" in orange | "last woke 14m ago · 5 events queued" | Unchanged; items stay actionable. | "Restart" chip (resume + wake now). |
| **Failed** (last wake errored) | `xmark.octagon.fill` "Wake failed" | A persistent `PaneNoticeStrip` (error kind) under the strip: the headline plus mono detail (3 lines), never auto-dismissed (ADR-0114 dismissal rule). | Unchanged. | "Retry", "Open log" |
| **Feed disconnected** | The header's existing `wifi.exclamationmark` | "status unknown — reconnecting". Numbers are hidden rather than shown stale. | Items greyed and **disabled**, "reconnecting…" | Pause and Kill stay **enabled**. They call the route directly and report failure (§8). |
| **Token unavailable** (the app cannot read the capability token) | `xmark.octagon.fill` "Can't control supervisor" | A notice strip: "MARVIN couldn't read the supervisor token" plus the path | Escalation cards read-only, with chips disabled and the reason shown. | "Retry" |
| **Delegated tab stopped by the user** | — | — | The row's chip shows its level. The subtitle gains "stopped — supervisor waits for you". | — |

## 8. Interaction

- **Every control is a `Button`, `Menu`, `Toggle` or `Picker`.** Rows keep their tap-to-focus, but each action also exists as a control and an accessibility action. Nothing is pointer-only (audit L24, S2).
- **Consent paths:**
  - **Reversible acts** take one click on the act chip: answer, an ordinary allow or deny, narrowing a posture, a local merge with its preview visible, open tab, resume.
  - **Outward acts** take two deliberate steps on the same card: "Review act…" expands the full act, then the act chip performs it.
  - Neither path has a default button or a Return binding.
  - After a click, the chip shows a small spinner and the card disables. On success the item leaves with an opacity fade. On refusal, a `PaneNoticeStrip` of the error kind appears in the card with the server's reason, and the card stays.
- **Pause, Resume and Kill** call the route at once and are optimistic only in the glyph. If the route fails, the strip shows an error notice: "Pause didn't reach the sidecar — the supervisor may still be running".
  - While the feed is disconnected they still try the route, because the route and the feed are separate connections.
  - Kill has no confirmation. Stopping is never the dangerous direction.
- **Disable** asks, through a `confirmationDialog` with Cancel as the default. Raising the cap and switching a category to autonomous do not ask: each is the user's own act, and each is ledgered.
- **Items resolve on their own.** When the underlying confirm is answered in the tab, the card leaves with an opacity fade and a one-line "answered in tab" toast is announced to VoiceOver. Nothing silently disappears under the pointer: if the item under focus resolves, focus moves to the next item.
- **Links in grounds** open the plan file, the ADR or `file:line` in the tab's tree. That is the same open path as Search results, which already scroll to the line.
- **Live updates apply in place,** keyed by item id and revision. There is no list-wide refetch on every event (the backlog lesson in the v0.1.115 notes).

## 9. Keyboard and VoiceOver

### 9.1 Keyboard

- **The pane keeps its model** (`SessionsPane.swift:73-86`): ↑ ↓ walk the rows in display order, and ⏎ switches to the focused tab. The ring is on the focused row, never on the pane.
  - Supervisor rows (§6.3) join the walk.
  - The status strip and the log section header are stops at the top and bottom of the walk.
- **On a focused row with an escalation card:**
  - **Space** expands or collapses the card. An expanded card shows the full act, which is how an outward act becomes available.
  - **Tab** moves into the card's controls in order: Show full act, grounds disclosure, the recommended act chip, the counter chip, ⋯. **Space** activates the focused control. **Esc** returns focus to the row.
  - There is **no single-key consent.** It is always Tab to the chip and then Space, and the chip's label names the act.
- **Registry commands.** They appear in the menu, the ⇧⌘P palette and the ⌘/ sheet together (`CommandRegistry.swift`). The shortcuts below are proposals, checked against the bindings currently in `CommandRegistry` (none collide). The builder must also check them against the system and app menus.

  | Command | Shortcut | Enabled when |
  |---|---|---|
  | Supervisor: Pause / Resume | ⌃⌥⌘P | enabled |
  | Supervisor: Kill | ⌃⌥⌘K | enabled; acts as Pause when idle |
  | Supervisor: Go to Next Escalation | ⌥⌘J | items exist; opens Sessions, focuses the oldest item |
  | Supervisor: Set Delegation for Current Tab… | — | enabled; opens the chip's menu |
  | Supervisor: Show Log | — | enabled |
  | Supervisor: Set Up… / Disable… | — | off / enabled |

### 9.2 VoiceOver

- **Headers.** Section headers and the strip title carry `.isHeader` (audit L25), so heading navigation reaches *Needs you*, the strip and the log.
- **The status strip** is one element `accessibilityElement(children: .contain)`:
  - **label** "Supervisor";
  - **value**, for example "Shadow. Watching 4 tabs. 3 dollars 20 of 10 dollars today. Last woke 2 minutes ago." The value names the state in words, never just "warning";
  - Pause, Kill and the menu are its children, each labelled ("Pause supervisor", "Kill current wake", "Supervisor options").
- **The budget meter** is a progress-indicator element with value "32 percent of daily cap".
- **The escalation card** is one combined element with:
  - **label** "Escalation, fix-flags tab: Only you can push. git push origin marvin/tab/fix-flags.";
  - **value** "Supervisor recommends: Deny. 2 grounds, 1 strong.";
  - **custom actions** named by the act chips' labels ("Deny", "Allow push" once the card is expanded), plus "Show full act", "Show grounds", "Open tab" and "Answer differently".

  The actions are exactly the visible chips, so VoiceOver never offers an act the card is hiding.
- **A custom rotor "Escalations"** lists every open item in the pane.
- **Announcements.** A new escalation posts one coalesced announcement after a short settle ("2 new escalations: fix-flags, docs-site"), not one per item. State changes are announced too: "Supervisor paused: daily cap reached", "Supervisor wake failed". This closes for this surface the gap audit C3 found: the confirm card is never announced today.
- **The delegation chip** is a `Menu` with label "Delegation for fix-flags" and value "answer questions".
- **The autonomy toggles** carry names, and each value includes its agreement line.
- **Ledger rows** have the label "Escalated push, fix-flags, 14:02" and the value "reason …; you answered …".
- **The transcript:**
  - a supervisor message reads "Supervisor message, not from you: …";
  - an answered-by chip reads "Answered by the supervisor, not by you";
  - the touched-turn divider is read in full.
- **Text and contrast.** Information-bearing text is ≥ 11 pt in `.secondary` or `textMuted`, never `.tertiary` (audit S4/L14). Timestamps that duplicate visible information may be 10.5 pt.
  - `textMuted` on `elevated` measures 5.58:1 in dark and 4.76:1 in light (audit contrast table), which passes.
  - Red and green chip text depends on the git colours, which fail in light mode (audit L4). Until `colorize` lands, a tinted chip always carries a glyph, and the recommended act uses `.primary`, not a tint.
- **Reduce Motion.** Arrivals and departures use opacity only, and are instant with Reduce Motion. Chips and icon buttons already drop their scale (`InlineActionChip.swift:78`, `PaneControls.swift:35`).
- **Increase Contrast.** The supervisor bubble's dashed stroke becomes a solid `textMuted` 1 pt line. Provenance badges keep outlined versus filled.

## 10. Backend fields each element needs

Names are proposals in the sidecar's camelCase. Each is grouped by the element that reads it, so the milestones can match them. "Server-derived" means the server computes it by rule, so the app holds no policy (the ADR-0114 principle: decisions are values, testable in `MARVINLogic`).

### 10.1 Status strip and expanded block — `GET /api/supervisor`, plus the `supervisor.state` feed event

| Field | Type | Used for |
|---|---|---|
| `projectId` | string | scope check |
| `revision` | int | in-place update ordering |
| `mode` | `"off" \| "shadow" \| "autonomous"` | off line vs strip; mode label |
| `autonomy` | `{questions, nudges, posture, confirms}: "shadow" \| "autonomous"` | "Autonomous · 2 of 4", the toggles |
| `run` | `"idle" \| "waking" \| "paused"` | line 1 state, Kill visibility |
| `pause` | `{reason: "user" \| "kill" \| "budget" \| "breaker" \| "refusals" \| "repeated-failures", at, detail?} \| null` | paused-state copy |
| `currentWake` | `{wakeId, startedAt, itemCount} \| null` | "Waking · 3 items" |
| `queuedEvents` | int | "3 events queued" |
| `lastWake` | `{wakeId, at, outcome: "ok" \| "failed" \| "aborted" \| "breaker", error?: {message, detail}}` | "woke 2m ago", failed state |
| `health` | `"ok" \| "stale" \| "failed"` + `healthSince` | stale/failed states, **server-derived** |
| `watchedTabs` | int (tabs with delegation ≠ off) | "watching 4" |
| `openEscalations` | int | "12 waiting" |
| `budget` | `{capUsd, spentUsd, spentOwnUsd, spentTabsUsd, resetsAt, level: "ok" \| "near" \| "reached"}` | meter, colour, copy (`level` server-derived) |
| `charter` | `{text, updatedAt}` | charter preview and sheet |
| `model` | `{role: "supervisor", resolved, label}` | expanded block |
| `stats` | per category `{proposals, agreed, agreedBlind, agreementRate, humanOnlyProposedAsAct, heuristicMisses}` | autonomy rows |
| `suggestedBar` | `{minProposals: 20, minAgreement: 0.9}` | "bar 20 / 90 %" |
| `confirmsEligible` | bool (any tab at `answer-confirms`) | Confirms toggle enabled |
| `caps` | `{maxActionsPerWake, maxTurnsPerWake, perTabRate, globalRate}` | settings sheet, read-only |

**Mutations** — `POST /api/supervisor`, token required. Each returns the new state with its `revision`, or `{error, reason}`:

- `start {charter, capUsd, delegations[]}`
- `pause`, `resume`, `kill`
- `disable`
- `delegate {sessionId, level}`
- `charter {text}`
- `cap {capUsd}`
- `autonomy {category, value}`
- `wakeNow` (Restart)

### 10.2 Escalation card and supervisor rows — `GET /api/supervisor/inbox`, plus the `supervisor.inbox` feed events (added / updated / resolved)

| Field | Type | Used for |
|---|---|---|
| `id`, `revision`, `createdAt`, `wakeId` | | identity, ordering, ledger link |
| `sessionId` | string \| null | null → supervisor row (§6.3) |
| `kind` | `"question" \| "confirm" \| "integration" \| "containment" \| "discard" \| "boundary-path" \| "posture-widen" \| "scope" \| "new-tab" \| "guardrail"` | glyph, card layout |
| `escalatedBecause` | `{code: "human-only" \| "ungrounded" \| "weak-grounds-only" \| "unresolvable-citation" \| "heuristic" \| "delegation-observe" \| "nudge-cap" \| "budget" \| "breaker" \| "refusals" \| "repeated-failures", label, rule?}` | "Why it is here" line; `rule` names the §4 item, for example `"§4.1 push"` |
| `heuristic` | `{matched: string} \| null` | "Question names an act: merge (heuristic)" |
| `rawAct` | `{toolName, input (full JSON), digest, summary, outward: bool, destructive: bool, paths?: string[]}` | raw-act block. `summary` is **server-built from tool and input deterministically**, never supervisor text. `outward` decides "Review act…" |
| `preview` | `{kind: "merge-tree", verdict: "clean" \| "behind" \| "conflict", behind?, added, removed, conflictFiles[]} \| null` | merge preview line |
| `question` | `{questions: [{header, question, multiSelect, options: [{label, description, preview?}]}]} \| null` | question card; the AskQuestionSheet hand-off |
| `linkedConfirm` | `{sessionId, toolUseId, raisingRule} \| null` | auto-resolve; replaces the inline confirm (no duplicate) |
| `recommendation` | `{actionId, answer?: {[questionText]: string \| string[]}, text}` | recommendation line; `text` is the supervisor's prose, length-capped by the server |
| `grounds` | `[Ground]` (see 10.6) | grounds disclosure |
| `actions` | `[{id, label, role: "consent" \| "refuse" \| "edit" \| "dismiss", recommended: bool, requiresExpanded: bool}]` | act chips; labels and order come from the server so the app invents no act verbs |
| `newTab` | `{firstMessage, tree: {baseRef, baseSha, mode: "worktree"}, posture: {model, modelLabel, effort, strategy, mode}, wider: string[], requestedBy: {kind: "user-message" \| "approved-proposal", ref, at}} \| null` | new-tab card |
| `postureChange` | `{from: Posture, to: Posture, widenedDimensions: string[]} \| null` | posture-widen card |
| `guardrail` | `{kind, detail, verb?: "raise-cap" \| "resume" \| "open-tab"} \| null` | guardrail rows |
| `modeAtCreation` | `"shadow" \| "autonomous"` | shadow marker |
| `state` | `"open" \| "resolved" \| "dismissed" \| "superseded"` + `resolvedBy: "user" \| "tab" \| "expired" \| null` + `resolvedAt` | leave and announce ("answered in tab") |
| `burstRank` | int (per-tab age order) | first card shown, the rest "+N more" |

**Routes:**

- `POST /api/supervisor/inbox {id, actionId, edits?}` — `edits` only for `new-tab` / `edit`. It returns the outcome or a reason. Consent is recorded `actor: "user"`.
- `GET /api/supervisor/inbox?state=open` returns the items oldest first.

### 10.3 Shadow "would answer" line — on the watch row, inside each `pendingConfirms[toolUseId]`

| Field | Type | Used for |
|---|---|---|
| `supervisorProposal` | `{ledgerId, actionId, answer?, grounds: [Ground]} \| null` | the §6.4 line |
| `proposalRevealed` | bool | blind vs revealed rendering |

**Route:** `POST /api/supervisor/reveal {ledgerId}` records `proposalSeenBeforeAnswer: true` on the pairing.

### 10.4 Delegation chip and tab rows — added to each `/api/sessions/watch` row as `supervisor`

| Field | Type | Used for |
|---|---|---|
| `delegation` | `"off" \| "observe" \| "answer-questions" \| "answer-confirms"` | chip glyph and menu check |
| `sharedCheckout` | bool (existing `tree.mode`) | menu note |
| `openEscalations` | int | "+N more for this tab" |
| `lastActAt` | ISO \| null | help text |
| `touchedTurn` | `{turnId, at, by: "message" \| "answer" \| "confirm"} \| null` | touched-turn divider, help text |
| `waitingOnOwn` | `"job" \| "wakeup" \| null` | "supervisor waits — tab waiting on its build" |
| `stoppedByUser` | bool | "supervisor waits for you" |

### 10.5 Supervisor log — `GET /api/supervisor/ledger?before=<seq>&limit=50&sessionId=&decision=`, plus the `supervisor.ledger` feed event (appended)

| Field | Type | Used for |
|---|---|---|
| `seq`, `at`, `wakeId` | | order, "Show 50 earlier" cursor, time |
| `actor` | `"supervisor" \| "user" \| "runtime"` | user/runtime rows (pause, delegate, rotation) |
| `sessionId`, `tabTitle` | string \| null; title snapshot at write time | tab name even after the tab closes |
| `verb` | string (`answer`, `send`, `cancel`, `set_posture`, `confirm`, `worktrees.merge`, `new_session`, `rotation`, `pause` …) | line 1 |
| `decision` | `"propose" \| "act" \| "escalate" \| "refuse" \| "drop"` | glyph, filter |
| `mode` | `"shadow" \| "autonomous"` | expanded row |
| `argDigest`, `argSummary` | string; summary is server-built | expanded row |
| `reason` | `{code, text}` | line 2 |
| `grounds` | `[Ground]` | expanded row |
| `pairing` | `{actualAnswer, answeredBy: "user" \| "supervisor", agreement: "agree" \| "disagree" \| "pending", proposalSeenBeforeAnswer: bool} \| null` | "you answered B ✓" |
| `inboxItemId` | string \| null | link to the card |
| `costUsd` | number \| null | expanded row |
| `hasMore` / `nextBefore` | on the response | paging |
| `todayCount` | on the response | section header count |

### 10.6 `Ground` (shared by inbox, ledger, shadow line, transcript)

| Field | Type |
|---|---|
| `kind` | `"plan-step" \| "dod" \| "adr" \| "memory" \| "charter" \| "file"` |
| `ref` | string — `"plan:[3]"`, `"ADR-0107"`, `"memory:<slug>"`, `"charter"`, `"file:<path>:<line>"` |
| `tree` | `"main" \| <sessionId>` — which checkout a file ref lives in |
| `label` | short human text |
| `provenance` | `"strong" \| "weak"` |
| `resolved` | bool |
| `excerpt` | string \| null (≤ 200 chars, for the expanded view) |
| `openTarget` | `{path, line?} \| null` — server-resolved absolute path the app can open |

### 10.7 Transcript marking — transcript lines and replay

| Field | Where | Used for |
|---|---|---|
| `author: "user" \| "supervisor"` | user-message line | outlined bubble vs the "you" bubble |
| `supervisor: {kind: "nudge" \| "instruction" \| "first-message", ledgerId, grounds: [Ground], editedByUser?: bool}` | the same line | footer, grounds |
| `answeredBy: "user" \| "supervisor"` + `grounds` + `ledgerId` | every `confirm.decision` (questions and confirms) | answered-by chip |
| `supervisorTouched: {at, by}` | turn record (start or on change) | touched-turn divider position |
| `postureSource: "user" \| "api" \| "supervisor"` + `postureRevision` + `postureSetAt` | session meta and watch row | posture-pill badge and help |

### 10.8 Models dialog — `/api/models/roles`

A `supervisor` role row with `role`, `label`, `description`, `default: {kind: "tier", tier: "sonnet"}`, `choice` and `resolved`. That is the existing `HelperRole` shape (`TopBarPopovers.swift:601-609`), with no new fields.

### 10.9 Token and connectivity

| Need | Field / source |
|---|---|
| The app can control the supervisor | the token file at `<MARVIN_DATA_DIR>/supervisor/token`; on a read failure, the app shows the "Token unavailable" state with the path |
| Distinguishing "not reachable" from "off" | the existing `feedConnected` plus the route's HTTP status |

## 11. Constraints and open decisions

**Constraints the builder must hold:**

- **ADR-0114.** No intrinsic `minWidth`. `Spacer(minLength: 0)`. No height transitions, no `.textSelection`, no `GeometryReader`, and no `.focusable()` container that rings the pane.
- **Snapshot verification.** Every state in §7 is captured in the snapshot harness at 260 and 420 pt, in light and dark (plan milestone 6 DoD: "measured, not assumed").
- **Server-supplied text.** No act verb, act summary, escalation reason or shadow/autonomous classification is computed in Swift. They come from the server fields above, so the app cannot drift from the policy.
- **Colour on chips.** Light-mode git colours fail contrast (audit L4). Chips that use them carry a glyph, and the recommended act is never a red or green tint.

**Open decisions — defaulted here; confirm before milestone 6:**

1. **Shadow proposals are blind until revealed** (§6.4), with the reveal recorded. The alternative, always visible, is simpler but anchors the user and inflates agreement.
2. **An edited new-tab first message** is still recorded `author: "supervisor"` with `editedByUser: true`. The alternative re-authors it as the user's. ADR-0127 §4 item 7 says confirming the brief is consent to open the tab "with it"; an edit makes the text partly the user's.
3. **Kill is a chip only during a wake.** It is in the ⋯ menu and the registry at all times.
4. **The proposed shortcuts** (⌃⌥⌘P, ⌃⌥⌘K, ⌥⌘J) need a check against the system and app menus.
5. **Not covered here:** a supervisor mark on the chat **tab strip** (the tab dots). The Sessions row and the transcript carry the information, and adding it is a separate call.

**Departures in the milestone 6 build (2026-10-30), each with its reason:**

1. **The budget meter is a fixed 56 pt, not "the strip width minus its text".** A width derived from the text needs a measurement view, which ADR-0114 / ADR-0062 rule out in the pane. A fixed bar is the same at 260 and 420 pt, which §4 asks for anyway.
2. **A posture change is announced on the feed (`session.posture`).** §10 had no such event, and nothing refreshed the watch rows on a timer, so the toolbar had no "one watch refresh" to wait for. The event carries ids and the revision only.
3. **Registry commands.** Pause / Resume (⌃⌥⌘P), Kill (⌃⌥⌘K), Go to Next Escalation (⌥⌘J), Show Log and Set Up… are registered; none collides with an existing binding. *Disable…* stays in the strip's ⋯ menu and settings block, because it needs the strip's confirmation dialog. *Set Delegation for Current Tab…* is not registered: the chip's `Menu` is the control, and a registry command cannot open a SwiftUI `Menu`. Go to Next Escalation expands the oldest item's card and announces it, rather than moving the row ring.
4. **The keyboard walk.** Supervisor rows join ↑ ↓, and Space / Esc expand and collapse the focused row's card. The strip and the log header are not walk stops; they are reachable as VoiceOver headings and by Tab. Moving the walk onto them would need a focus model for non-row chrome, which the pane does not have.
5. **The escalation card is one combined accessibility element** whose custom actions are exactly its visible chips (`SupervisorActChips.accessibilityActionNames`, pinned by a test). Its chips stay reachable by keyboard focus.
6. **"Answered in tab".** The card leaves with an opacity fade and VoiceOver announces "Answered in tab: <tab>". There is no visual toast; a toast would be a second notice for a card the user is watching disappear.
7. **A live supervisor message appears after the next hydrate, not in the live stream.** The sidecar puts `turn.started` on the live bus for a supervisor-started turn but no `turn.user` line, so a client attached live has nothing to render until it re-reads the transcript. The answered-by chip *is* live (from `confirm.resolved`).
8. **The posture-pill badge sits on the mode pill** (`ChatModeToolbar`), the pill a supervisor narrowing most often changes; its time is when the app adopted the change.
9. **The new-tab Edit… sheet narrows mode and strategy only.** Model and effort are shown read-only on the card. The server refuses any widening in either case.
10. **Existing tab-row subtitles stay 9.5 pt tertiary** (audit L14 is out of this milestone's scope); supervisor rows and supervisor lines in a row use 10.5 pt `.secondary` as §6.3 asks.
11. **The status strip has three lines, not two.** Beside Resume, ⋯ and the chevron, line 1 truncated the state to "⚠ …" at 260 pt (critique P1, 2026-10-30); the state now has its own line between the title and the budget line.
12. **Notice strips inside the surface carry no inline verb.** A guardrail's or failed wake's verb chip sits on its own line under the notice; inline, it wrapped the detail one word per line at 260 pt. The failed-wake notice's ✕ hides that failure until a different one arrives.
13. **An escalated tab always has a row.** A tab that is neither open nor live still appears in *Needs you* when it has open items, titled from the inbox's snapshot; otherwise its items were counted but never drawn.

**Departures in the milestone [7.4] build (2026-10-31), from the Supervisor tab's renders at 260 and 420 pt, light and dark, and the critique that followed (31/40):**

14. **The reply's label heads its text, not the gutter.** "binoculars SUPERVISOR" at caption2 mono, tracked, is about 76 pt and wrapped as SU-PER-VISOR in the 56 pt gutter. The label now sits above the reply, as §6.8's sits above a bubble; the gutter stays empty so the text column (and the cards under it) keep the transcript's indent. *Kept, not changed:* that indent costs a quarter of a 260 pt column; it aligns the tab with the transcript, which §12.2 asks for.
15. **The composer is the chat composer's box, transparent and three lines tall.** `ChatTextEditor` drew its own opaque fill over the placeholder in a 120 pt block. It gains an opt-in `transparent` (the chat composer is unchanged); the box is the chat's: elevated fill, radius 10, hairline. It is a fixed 64 pt so the placeholder never truncates "never consent for you" at 260, and the placeholder is `.secondary`, not the chat's `.tertiary`: it carries the consent rule, and `.tertiary` is about 2:1. While a send is in flight the editor dims.
16. **A message sending shows its bubble at once with "Sending…" under it** (§12.6); before it, a sending bubble looked like a sent one. A message waiting while the supervisor is paused reads "Waiting — the supervisor is paused", not "Waiting for the next wake". §12.4's "Waiting for the current wake" is built as "Waiting for the next wake": the line shows only between wakes.
17. **At the cap there is one notice: the budget card.** ADR-0128 §7's budget `guardrail` item is drawn at the foot of the conversation, full column width (at the reply indent its detail truncated at 260). While it is there, the paused notice is not; for any other pause the notice carries *Resume* on its own line (§12.4). `PaneNoticeStrip`'s ✕ is now optional: the paused notice had one that did nothing.
18. **The card's chip row wraps.** In the chat's 170 pt column at 260, one row of chips pushed an observe-send card past the edge. The chips still sit on their own line(s); at 260 the ⋯ may wrap alone. This holds in *Needs you* as well, since it is one component.
19. **A follow's label keeps its full lines and *Stop following* sits under it.** Beside the chip, at 260, the label lost "until it is ready to merge".
20. **Warning text is not orange; its glyph is.** "leaves this Mac", "destroys work" and "The supervisor couldn't answer this" were system orange at about 2:1 on light chrome. The glyph keeps the hue and the words are primary or secondary text, as the diff rows already do (DESIGN.md).
21. **The raw act's tool badge is neutral** (the hairline fill), not orange. A warning hue on every act, a reversible merge included, said nothing; the outward / destructive line beside it carries the warning. The chat's tool-kind tints (teal, blue, indigo, purple) are a different element and are unchanged.
22. **An item in the chat is drawn by its kind** (`SupervisorItemCard`, shared with *Needs you*): a new-tab proposal with its brief, tree and posture, a guardrail as its notice and verb, anything else as the escalation card. Before it, every chat item was an escalation card, which drew a new-tab proposal without its brief.

**Recorded, not changed:**

- **"Done — Merge marvin/tab/…"** reads as an imperative under "Done". The words after the dash are the server's raw-act summary, and the app invents no act verb (constraint above), so §12.2's "Done — you merged fix-flags" waits on a server-side past-tense summary.
- **The guardrail detail is 9.5 pt mono** in `PaneNoticeStrip`, under the 11 pt floor; the open backlog item on the chrome info-text floor covers it.
- **§12.2's collapsed line per other wake is not built.** It is tagged [7.4] above but is in neither the plan's [7.4] touchpoints nor its fixture list; it needs the ledger's per-wake summary in the conversation's read, which is its own slice.

## 12. The Supervisor tab (ADR-0128, plan milestone 7)

- **Status:** shaped 2026-10-31 (Impeccable `shape`), before any Swift for it ([7.1]). Milestone [7.1] builds the minimal tab: placement, composer, the conversation, the working indicator, the empty state. Milestone [7.2] adds the cards, [7.3] refs and follows, and [7.4] the remaining states and the renders. **Built 2026-10-31:** every §12.6 state and the [7.2]/[7.3] card, follow and report states are snapshot fixtures (`SurfaceSnapshotSupervisor.chatStates`), rendered at 260 and 420 pt, light and dark; what the renders and the critique changed is §11, departures 14–22.
- **Visual authority:** unchanged. "The Quiet Instrument", §3's one mark (`binoculars` plus "supervisor" in SF Mono) and §6.8's outlined, unfilled supervisor shape. **No new colour, radius or component family.** The tab is assembled from the chat strip's `chatTab`, the transcript's user bubble (`ChatMessageRow`), its prose renderer (`RichText`), the composer's `ChatTextEditor`, §6.2's escalation card (from [7.2]) and `PaneNoticeStrip`.
- **Discovery answer** (2026-10-31, given by Robert's supervisor session; the recommended option): **the reply is drawn like an assistant turn** — left gutter, no bubble. §6.8's dashed bubble keeps one meaning only: a supervisor message inside a tab's transcript, input to that tab. In its own tab the supervisor is the other party.
- **Thesis: *a conversation with the watcher, where the only buttons are the inbox's.*** The supervisor talks in text. Anything that can act is a card the server built, never a line the supervisor wrote.

### 12.1 Placement

- **Pinned first in the chat tab strip** (`ChatPreviewView.sessionTabs`), before every chat tab and before a "New chat" tab.
  - Glyph `binoculars`, title "Supervisor". It uses `chatTab`'s geometry and compression, so it shares the strip's width budget and is never wider than a chat tab.
  - It has **no close ×** (ADR-0128 §1: closing hides; Pause and Kill stop). It has no branch chip, no posture pill and no mode toolbar.
  - It does not join ⇧⌘[ / ⇧⌘] or the overflow menu's tab list; those walk *chat* tabs. It is one click, or the strip's first stop for VoiceOver.
- **Also in the left activity rail** (2026-10-31, asked for by the user: with many tabs open the pinned tab gets lost). A `binoculars` icon below the pane icons, set apart by a hairline, on the same visibility rule as the tab. It opens no pane: clicking it selects the pinned tab. Its badge counts the open inbox items, which is the supervisor's share of the *Needs you* count. Selected while the conversation is shown, with no accent bar, because that bar marks the open pane. Both entry points stay. They are two ways to reach one place, not two switchers (ADR-0112), and the tab still decides what the chat column shows.
- **Shown only while the supervisor is enabled** (`mode != "off"`), paused included. When it is off, the tab is absent and §6.7's off line stays the one place to start it. There is no second *Set up…* (ADR-0112).
- **Selecting it replaces the chat body** (transcript, tray and composer) with the Supervisor conversation. The project's chat model is not touched: the selected chat tab stays loaded, and choosing a chat tab returns to it as it was. The conversation never goes through `ChatPreviewModel` or `/api/chat` (ADR-0127 §2).
- **If the supervisor is disabled while the tab is selected,** the strip falls back to the last selected chat tab.

### 12.2 The conversation

One column, oldest at the top, the newest pinned to the bottom like the chat.

- **The user's message.** Exactly the transcript's user bubble (`ChatMessageRow`, role user): right-aligned, the accent-tinted fill, radius 12, 12 × 8 padding, the "you" label. The user's words are the user's (ADR-0128 §2.1), so they are drawn as the user's.
- **The supervisor's reply.** Left-aligned with the transcript's 56 pt role gutter, like an assistant turn, never right-aligned and never filled.
  - **Gutter label:** `binoculars` plus "SUPERVISOR" in caption2 mono, tracked, uppercase, in `textMuted` — §6.8's label, so the supervisor reads the same in a tab's transcript and here.
  - **Body:** the reply's Markdown in the transcript's prose style (`RichText`), with **every link removed**: no Markdown link, no autolink, no file link, no pointer cursor. A URL stays visible as inert text (ADR-0128 §3, "the supervisor's text cannot draw a card").
  - **Footer** in caption `.secondary`: the time. From [7.3], the server-resolved `refs` render here as links; they are the only links a reply ever carries.
- **Every other wake: one collapsed line** ([7.4]). A hairline-free meta row in caption `.secondary`: "Woke for 3 items: answered a question in *fix-flags*, escalated a merge", with a chevron that opens the matching entries in the Supervisor log. No tool calls are shown here; they are the log's.
- **Cards ([7.2]).** An inbox item a message wake raised renders **under the reply that lists it**, with §6.2's escalation card component and the server's `actions`, indented to the reply's text column. It is the inbox item, not a copy: settling it here settles it in *Needs you*, and the reverse. A settled card collapses to its one-line outcome ("Done — you merged fix-flags"). Outward and destructive acts expand first (discovery answer 2).
- **Width.** The chat column, not the pane: the reply's text column is the transcript's, so the 260 / 420 pt rule of §5 does not apply. The transcript's existing `minWidth: 0` and truncation rules do.

### 12.3 The composer and its focus rule

- **The chat composer's text editor** (`ChatTextEditor`), with no mode toolbar, no model chip, no attachment button, no slash commands and no image paste. Placeholder: "Message the supervisor — it can propose, never consent for you".
- **Return sends; ⇧Return inserts a newline.** The send button is the chat's. It is disabled while the text is empty or over 4,000 characters, and while a send is in flight.
- **Focus stays in the composer.** Sending keeps it there. A reply, and from [7.2] a card, never takes focus. **Return in the composer sends the composer and never reaches a chip** (ADR-0128 §1).
- **A refused send stays in the composer** with a `PaneNoticeStrip` of the error kind above it, carrying the server's reason ("the message carries a secret-shaped string — it was not sent"). Nothing the user typed is lost.
- **Sending is never refused for rate** (ADR-0128 §6). A message sent while a wake is running shows under the running indicator and is answered by the next wake.

### 12.4 The working indicator

- **While `currentWake` is set,** a meta row at the bottom of the conversation: a mini `ProgressView`, then "Supervisor is reading…" in caption `.secondary`. It is the same for a message wake and any other wake, because a wake started by a tab still holds the user's next message until it ends.
- **A message the next wake will carry** shows its bubble at once, with "Waiting for the current wake" under it in caption `.secondary` until a wake carries it.
- **Paused or killed:** no spinner. A `PaneNoticeStrip` of the warning kind above the composer reads "Paused — your message waits until you resume", with the strip's *Resume* chip on its own line beneath it (§11, departure 12). Messages still send; none is dropped.

### 12.5 The empty conversation

- A centred `PaneEmptyView`-style block: `binoculars` in `textMuted`, "Talk to the supervisor", and one line of `.secondary` text: "Ask it about your tabs, or for a tab to be opened. What it may not do on its own comes back as a card you click."
- No sample prompts and no suggestion chips: a chip in this tab would read as an act.

### 12.6 States

| State | Strip | Conversation | Composer |
|---|---|---|---|
| **Off** | Tab absent | — | — |
| **Enabled, empty** | Pinned tab | §12.5 | Enabled |
| **Message sending** | — | The bubble at once; it disappears again only if the server refuses it | Disabled until the route answers |
| **Wake working** | — | §12.4 indicator | Enabled |
| **Reply arrived** | — | Reply under the message, after one `supervisor.message` event | Focus unchanged |
| **Paused / killed / over budget** | Tab stays | §12.4 notice; at the cap, [7.2]'s inline budget `guardrail` item with *Raise cap…* | Enabled |
| **Token unavailable** | Tab stays | §7's notice | Disabled, with the reason |
| **Feed disconnected** | — | Conversation stays; "reconnecting…" under the last message | Enabled; the route is a separate connection |

[7.4] renders every row at 260 and 420 pt wide chat columns, light and dark, plus the [7.2]/[7.3] card, follow and report states.

### 12.7 Keyboard and VoiceOver

- **Keyboard.** Selecting the tab focuses the composer. Tab order: the conversation (each reply is one stop; [7.2] cards follow their reply), then the composer. No single-key consent anywhere (§9.1).
- **The tab** reads "Supervisor conversation, tab", with value "working" during a wake.
- **A user message** reads "You: …". **A reply** reads "Supervisor reply, not from you: …" — never "you" (ADR-0128 §1, [7.4] DoD). Each is one combined element.
- **Announcements.** A reply is announced once, at polite priority: "Supervisor replied". A refused send is announced with its reason.
- **Reduce Motion.** Arrivals use opacity only. **Increase Contrast** changes nothing new: the reply has no outline to strengthen, and the user bubble is the chat's.

### 12.8 Backend fields

| Need | Field / source |
|---|---|
| Whether the tab exists | `GET /api/supervisor` `mode`, plus the `supervisor.state` feed event |
| The conversation | `GET /api/supervisor/message?projectId=` → `messages[]`: `id`, `at`, `from` (`user` / `supervisor`), `text`; a reply also carries `wakeId` and `origin` (`{kind: "message", messageIds}`). [7.2] adds `items[]`, [7.3] `refs[]` and `kind: "report"` |
| Sending | `POST /api/supervisor/message {projectId, text}` with the token → `{id, at}`; 400 / 409 carry `error` |
| A new message or reply | `supervisor.message {projectId, id, from}` on the project feed (ids only); the app re-reads the `GET` |
| The working indicator | `GET /api/supervisor` `currentWake` (`wakeId`, `startedAt`, `itemCount`) |
| Waiting messages | a user message with no reply whose `origin.messageIds` names it |
