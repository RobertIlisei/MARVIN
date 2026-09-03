# MARVIN in practice — modes & the decision workflow

This guide shows how MARVIN actually works a session: the three **modes**
you drive it with (Ask / Agent / Plan), how it **decides** what to do, and
what a real exchange looks like in each. For the conceptual "why phases,
not agents" background see [The 8-phase workflow](../concepts/eight-phase-workflow.md);
this page is the practical, example-driven companion.

> The transcripts below are **illustrative** — trimmed to show the shape of
> an exchange, not verbatim logs. Chips in `[brackets]` are the UI surfaces
> MARVIN renders (mode selector, plan card, confirm gate, to-do strip).

---

## Two dials, not one

MARVIN separates *what it may attempt* from *how each edit is confirmed*.
They're orthogonal — you set them independently.

| Dial | Values | Question it answers |
|---|---|---|
| **Mode** | `Ask` · `Agent` · `Plan` | What is MARVIN allowed to do this turn? |
| **Permission strategy** | `auto` · `gated` | How does each edit get confirmed while it works? |

- **Mode** lives in the input toolbar. Default is **Agent**.
- **Permission strategy** is the header `perms` toggle. Default is **auto**
  (full bypass, like `claude --dangerously-skip-permissions`); flip to
  **gated** to get a confirm card back on every Edit / Write / unsafe Bash.

The two compose. `Agent + auto` is heads-down autonomy; `Agent + gated`
is autonomy with a diff to approve on each write; `Plan + gated` is the
most deliberate. Ask mode ignores the strategy — it can't write regardless.

---

## Ask mode — read-only Q&A

**What it is.** Exploration and explanation. MARVIN reads, queries the
knowledge graph, traces call paths, and answers — but **cannot** edit,
write, or run a mutating command. This isn't a prompt-level promise: the
permission gate hard-denies any mutating tool in Ask mode, with an
SDK-level `disallowedTools` backstop. Read-only is *enforced*, not advised.

**When to use it.** "How does X work?", "Where is Y implemented?",
"What breaks if I change Z?" — any time you want understanding without
risk of the workspace changing under you.

**Illustrative session:**

```
[Mode: Ask]

You:  How does session auth flow through the sidecar?

MARVIN: Querying the knowledge graph first…
        [graph: 6 nodes matched — auth path]

        Auth enters at `POST /api/chat` (sidecar/src/app/api/chat/route.ts),
        which calls `resolveCredentials()` in packages/runtime/src/auth.ts.
        That takes the key configured in Settings and falls back to
        `ANTHROPIC_API_KEY`. The key is never persisted to the
        transcript — it's read per turn.

        Want me to trace where it's attached to the outbound SDK call?

You:  actually just fix the fallback to log a warning

MARVIN: I'm in Ask mode, so I can't edit. Switch the mode selector to
        Agent (or Plan) and I'll make the change — the edit itself will
        still go through your confirm gate if you're in gated.
```

The refusal is the feature: in Ask mode you can hand MARVIN anything —
a production repo, a client's code — and know it's strictly observational.

---

## Agent mode — full autonomy (the default)

**What it is.** MARVIN reads, edits, runs commands, and moves through a
multi-step task end to end. This is the default, and it's the *autonomy
level of the one assistant* — never a spawned team of implementation
agents ([single assistant](../concepts/single-assistant.md) is a hard rule).

For any task of three or more steps, MARVIN emits a **tier-1 task list** —
a neutral blue **`[Task list]`** strip above the input that ticks off live
as it works. That's a bare checklist with *no plan behind it*; it's the
lightweight tracker for "just do it" work.

Each edit is confirmed by your **permission strategy**:

- **auto** — edits apply with no prompt; MARVIN narrates what it changed.
- **gated** — every Edit / Write / unsafe Bash renders a **`[Confirm]`**
  card with the exact diff (Monaco viewer). You Allow or Deny-with-a-note;
  a denied edit comes back reworked, not abandoned. Reads and whitelisted
  commands auto-allow; destructive patterns hard-deny in *both* strategies.

**When to use it.** A well-scoped change you're happy to let MARVIN carry:
"add a rate limiter to the login route", "fix this failing test", "wire up
the new env var".

**Illustrative session (`Agent + gated`):**

```
[Mode: Agent]  [perms: gated]

You:  Add a 5-req/min rate limiter to POST /api/login.

MARVIN: [Task list]
        1. Locate the login route + existing middleware
        2. Add a token-bucket limiter keyed by IP
        3. Return 429 with Retry-After on trip
        4. Add a functional test
        5. Typecheck + run tests

        Graph points at src/app/api/login/route.ts and a middleware
        helper already used by /api/chat. Reusing it.

        [Confirm] Edit  src/app/api/login/route.ts   (+18 −2)
        ┌─ diff ─────────────────────────────────────┐
        │ + const limit = tokenBucket({ rpm: 5, … })  │
        │ + if (!limit.ok) return json(429, { … })    │
        └─────────────────────────────────────────────┘

You:  [Allow]

MARVIN: Applied. ✓ 2/5
        [Confirm] Write src/app/api/login/rate-limit.test.ts (+34)
        …

        ✓ 5/5 · typecheck clean · 3/3 tests pass

        Scope met: login route rate-limited at 5 rpm, returns 429 +
        Retry-After, covered by a functional test, typecheck + tests green.
        Anything else, or should I stop?
        [Save to memory.md]  [Start fresh next turn]
```

Two things worth noticing: the **task list** made the plan-of-attack
visible before any edit, and every turn of real work ends with an explicit
**scope-met handoff** — MARVIN restates the Definition of Done as
past-tense facts and stops, rather than drifting into adjacent "while I'm
here" changes (see [taking decisions](#how-marvin-takes-decisions) below).

---

## Plan mode — draft, approve, then execute

**What it is.** A deliberate two-phase flow for anything big or
irreversible. Plan mode runs a **read-only planning turn** — MARVIN can't
touch the workspace while planning — and presents a numbered plan **inline
as a plan card** that opens with `# Plan — <title>`, then **stops**. The
planning turn runs on your chosen **advisor/planner** model.

Approving is a distinct, explicit act: an **`[Approve & execute]`** chip
switches into **Agent mode** and runs the plan in a *separate* turn on your
**executor** model. Because execution isn't planning, MARVIN can't silently
re-plan mid-flight. The approved plan becomes a **tier-2 checklist** — a
purple **`[Plan — <title>]`** strip that persists and ticks off *in place* —
and the plan is written to `<workDir>/.marvin/plans/<slug>.md` and opened in
the editor so you can follow along.

**When to use it.** Multi-milestone features, migrations, anything touching
a public contract, or work where you want to approve the *approach* before a
single line changes.

**Illustrative session:**

```
[Mode: Plan]

You:  Migrate the cost tracker from a JSON file to SQLite.

MARVIN: [Plan — Cost tracker → SQLite]      ← read-only, presented inline
        # Plan — Cost tracker → SQLite

        1. Add better-sqlite3 + a schema migration (cost_events table)
        2. Dual-write: keep JSON, also write SQLite (safety net)
        3. Backfill existing cost-tracker.json → SQLite (one-shot script)
        4. Switch reads to SQLite; JSON becomes read-only fallback
        5. Remove the JSON path once a release has proven the migration

        Blast radius: 3 read sites (status bar, /api/cost, weekly rollup).
        Milestone 5 is deferred to a follow-up release, not this change.

        [Approve & execute]   [Ask a question]

You:  [Approve & execute]

MARVIN: [Plan — Cost tracker → SQLite]  ← now ticking off, on the executor
        ✓ 1  schema + migration added
        ✓ 2  dual-write in place
        ~ 3  backfilling… 1,204 events migrated
        …
```

The split matters: you reviewed and approved the *strategy* on a
planner-grade model, and only then did the executor start changing files —
with the plan pinned as a live checklist that survives chat switches and
relaunches.

---

## Graphify first — how MARVIN uses the knowledge graph

Before MARVIN reads a source file to answer a structural question — "how
does X work", "who calls Y", "what breaks if I change Z" — it queries a
**knowledge graph** of the project. This isn't optional flavour; it's a
hard rule ([graphify integration](../concepts/graphify-integration.md)).
Querying the graph is far cheaper per question than reading files, and it
catches structural couplings a keyword grep would miss. "Grep and pray" is
the failure mode the rule exists to kill.

Each project gets two graphs, and every query names a **scope**:

- **`code`** — the AST graph (functions, types, calls, imports).
- **`knowledge`** — headings and cross-links from the docs, ADRs, and
  memory. `scope: "all"` queries both.

The graph tools MARVIN reaches for, in rough order of a session:

| Tool | What it's for |
|---|---|
| `graph_summary` | Orient on a cold project — god nodes, communities, size. |
| `graph_query` | Ask a natural-language question; get BFS-ranked nodes with source citations. |
| `graph_search` | Keyword lookup for a specific symbol or concept. |
| `graph_neighbors` | Trace the couplings around one node (blast radius). |

**Real anonymized example.** In the same session, a surprising behaviour
needed a root cause. MARVIN's first move was the graph, not a grep:

```
You:  Creating a new admin user seems to spin up a separate workspace per
      user instead of one shared workspace. Why?

MARVIN: [graph_query · scope: code]
        "Why does creating a new admin user create a separate workspace
         per user instead of one shared workspace?"
        → 7 nodes ranked, with file:line citations

        The graph points at the user-provisioning service and the SSO
        callback handler — the workspace is derived per-identity there,
        not looked up from a shared record. Reading those two locations
        now to confirm.

        [Read] provisioning service  ·  [Read] SSO callback
        Confirmed: the callback mints a workspace from the identity claim
        with no "shared-workspace" branch. That's the bug.
```

The graph did the *locating* (which two files, out of hundreds); the file
reads did the *confirming*. That order — graph to point, files to verify —
is the whole discipline. MARVIN cites the `file:line` the graph surfaced,
never a structural claim from imagination.

**Keeping the graph fresh.** While the MARVIN IDE has a project open it
auto-refreshes that project's graphs every turn (AST-only, no LLM cost), so
the graph tracks the code as it changes. A richer semantic pass — the
`/graphify` skill — is manual and opt-in for when you want community
detection and an audit report over the whole corpus.

---

## How MARVIN takes decisions

Underneath every mode is the same decision discipline — a senior-engineer
workflow MARVIN moves through in *one* conversation (no agent hand-offs).
The full phase-by-phase rationale is in
[The 8-phase workflow](../concepts/eight-phase-workflow.md); here's what
actually governs its choices while it works.

**Plan-first, execute-second, verify-third.** For anything non-trivial
MARVIN sketches the approach before writing code and checks it after.
Trivial edits (a typo, a one-line comment) skip the ceremony — it won't
write an ADR for a rename.

**Blast radius before architecture.** Before proposing changes, MARVIN
enumerates what the change touches (direct + transitive consumers, contract
surfaces) using the knowledge graph, and classifies each as `no-change` /
`mechanical-update` / `semantic-review` / `breaking`. This is where "oh, we
also need to update the CDK stack" gets caught early.

**Some decisions stop for a written record.** MARVIN writes an **ADR**
(architecture decision record, to `<workDir>/docs/adr/NNNN-slug.md`) when a
decision is material and hard to re-derive — a new dependency, a schema or
protocol change, a security-sensitive choice, a non-backward-compatible
move. It does *not* ADR trivia. For genuinely hard or high-blast-radius
calls it also runs a bounded, **read-only advisor** — a second-opinion
subagent that stress-tests the alternatives before you ever see the plan.

**Define done before doing — match, not improve.** For real work MARVIN
states a falsifiable **Definition of Done** (3–5 bullets an observer could
mark "yes that happened" / "not yet") *before* coding, and verifies against
exactly that — not an ever-expanding sense of quality. Adjacent
improvements it notices mid-task are surfaced as "noticed in flight, not in
scope" and parked (to the backlog) or asked about — never silently landed.
This is the guard against the **"helpful spiral"**: six commits past the ask
because each step seemed worth doing.

**Every real-work turn ends with a handoff.** MARVIN restates the
Definition of Done as past-tense facts and asks whether to continue —
`Scope met: … Anything else, or should I stop?` — with a chip to save a
durable fact to memory or start fresh. Durable facts (invariants, gotchas,
constraints) go to the project's memory via the `remember` tool; status
goes to git; decisions go to ADRs.

**Illustrative session (a decision that stops for an ADR):**

```
[Mode: Plan]

You:  Let's add rate limiting across all API routes. Redis-backed.

MARVIN: This crosses an ADR trigger — a new external dependency (Redis)
        and a cross-cutting contract change. Pausing at the architecture
        phase to write it down before planning milestones.

        [advisor] stress-testing alternatives… (in-memory vs Redis vs
        edge/CDN limits) — done.

        Drafted docs/adr/0007-api-rate-limiting.md:
          Context · Decision (Redis token bucket) · Consequences
          (new infra dep, shared across instances) · Alternatives
          (in-memory: rejected — doesn't survive multi-instance;
           CDN: rejected — no per-user granularity) · Scope of Done

        I've stopped here — review the ADR. Approve it and I'll turn it
        into a milestone plan; or push back and I'll revise or write a
        superseding record.
```

The decision got a durable artifact *before* any code, the advisor
pressure-tested it first, and MARVIN **stopped for your approval** rather
than assuming. That pause is the whole point — a wrong architectural turn
is cheapest to catch here.

---

## A real session, anonymized — a multi-turn plan

The examples above are illustrative. This one is **a real MARVIN Plan-mode
session**, with the domain generalized: it was a compliance-reporting
platform that has to satisfy a national regulator and an EU-level
framework, and the goal was to move toward a defensible "100% compliant"
claim. Everything below preserves the *shape* of the actual exchange — the
domain specifics (industry, jurisdiction, regulator, filenames, regulation
numbers) are scrubbed.

**The ask (Plan mode):**

```
You:  [screenshot attached] Prepare a deep research pass. Make sure our
      report generation contains every detail the national + EU regulators
      require — I want to know exactly where we stand on 100% compliance.
```

**What MARVIN produced** — not a to-do list, but a plan *grounded in the
project's own history*, because past decisions bind (this is the
cross-session ramification discipline in action):

```
[Plan — Regulatory-Completeness Deep Research]

# Plan — Regulatory-Completeness Deep Research

## Context this plan is built on (already verified, read-only)
- A dozen report types exist (found in the report-type registry).
- Two prior audits already mapped the gap taxonomy, and an earlier ADR
  in this project closed the first batch of gaps — but they cited code +
  secondary regulatory summaries, not primary authoritative texts. A
  "100% compliant" claim needs each mandatory field traced to a primary
  article/annex/table.
- Known-open gaps and one deferred decision (no authoritative national
  source held for it yet) are carried forward, not rediscovered.

## Research steps (1–7 read-only; 8 produces decisions)
1. Assemble the authoritative primary-source corpus; flag every source we
   CANNOT obtain (drives the no-fabrication boundary).
2. Build the master requirement matrix — every mandatory field × report
   type × primary-source citation × in-force date × severity.
3. Re-verify current output against the matrix, field by field, down to
   file:line in the templates and schemas.
4. Machine-readable-readiness assessment for the upcoming mandate.
5. Re-assess the single largest credibility gap — decide: build the engine
   now, or disclaim-and-defer with a documented trigger.
6. Cross-register / feeder completeness pass.
7. Consolidate into one triaged gap register (blocking-now / dated-mandate
   / future), de-duplicated against the backlog.
8. Produce the remediation roadmap (decisions, not code) — advisor consult
   on the one high-stakes call before any ADR is drafted.

## Calls for you
- Steps 1–7 are read-only research; step 8's decisions come back for
  approval before any code.
- Primary-source acquisition is the critical dependency: I can fetch the
  EU-level texts; the national regulator's binding orders often aren't
  web-fetchable — you may need to supply those PDFs. Anything I can't cite
  stays marked "not evaluated" under the no-fabrication rule.
- Scope question: include the 2027+ forward-looking requirement now, or
  hold it as explicitly future?
```

Three things this real plan shows that a toy example can't: it **built on
two prior audits and an earlier ADR** instead of starting from zero; it
drew a hard **no-fabrication boundary** (won't claim compliance for a field
it can't cite to a primary source); and it **surfaced its own blockers and
scope questions** rather than guessing.

**Approve and execute:**

```
You:  The plan you just presented is approved — execute it now. Work
      through it in order, and maintain a TodoWrite checklist.

MARVIN: [Plan — Regulatory-Completeness Deep Research]  ← ticking off live
        ✓ 1  primary-source corpus assembled (EU texts fetched; 3 national
             PDFs flagged as user-supply)
        ~ 2  requirement matrix — 40+ fields mapped…
```

**Staying on the rails across many turns.** A plan this size spanned a
full working day and many turns. Each time work resumed, the **Continue**
control re-anchored MARVIN to *this* plan — not a fresh scan of the repo:

```
You:  Resume the ACTIVE plan below — and ONLY this plan. Do NOT start a new
      audit, do NOT scan the project for other open work.
```

That guardrail is exactly the anti-"helpful-spiral" discipline: a paused
plan resumes itself instead of ballooning into a whole-project re-audit.

**Decisions, with the advisor:**

```
You:  Review the ADR with the advisor, and if it holds up, continue.

MARVIN: [advisor] stress-tested the decision — flagged five blocking gaps
        (an overflow bug, a missing 404 path, resolve idempotency, a
        server-side scope check, an auth clarification). Amended the ADR to
        close all five, plus the retention questions. Presenting it now.

You:  For each open decision you just raised, proceed with your own
      recommended option. If one has no clear recommendation, pick the
      lowest-risk option and say which you chose. Then resume the plan.
```

The advisor caught five real defects *before* the decision was ratified;
MARVIN folded them in and only then brought the ADR back. That's the whole
loop — **plan → approve → execute-on-rails → decide-with-a-second-opinion →
verify** — running on a genuine, complex piece of work.

---

## Picking a mode — quick reference

| You want to… | Mode | Strategy |
|---|---|---|
| Understand code with zero risk of changes | **Ask** | (n/a) |
| Let MARVIN carry a scoped change, hands-off | **Agent** | auto |
| Same, but approve each diff | **Agent** | gated |
| Approve the *approach* before anything changes | **Plan** | auto or gated |
| Do something big, irreversible, or contract-breaking | **Plan** | gated |

You can switch modes mid-session — planning turns, execution turns, and
read-only questions freely interleave in one conversation.

---

## Related

- [The 8-phase workflow](../concepts/eight-phase-workflow.md) — the
  conceptual spine behind "how MARVIN takes decisions".
- [Single assistant, not an agent team](../concepts/single-assistant.md) —
  why "Agent mode" is one assistant's autonomy, never a dispatched team.
- [The confirm gate](../concepts/confirm-gate.md) — how `auto` / `gated`
  classify and confirm each tool call.
- [Advisor strategy](../concepts/advisor-strategy.md) — the read-only
  second-opinion subagent.
- [ADR-0036](../decisions/0036-ask-agent-plan-modes.md) — the modes
  decision. [ADR-0046](../decisions/0046-plan-as-durable-spine.md) — plan
  as a durable, reconciling spine.
