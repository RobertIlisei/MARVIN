# Jev (TypeSafe AI "System One" model): should MARVIN use it?

- **Date:** 2026-09-23
- **Status:** Research and proposal. No code written, no ADR yet. Adopting it would need ADR-0120, because it adds a new external model and a new path for project data to leave the machine.
- **Inputs:** the announcement post, TypeSafe's docs, and a deep-research pass (21 sources, 104 claims extracted, 25 verified by 3-vote adversarial check, 23 confirmed, 2 refuted). Sources are at the end.

## TL;DR

**Don't put Jev in any live path. At most, trial it in an offline evaluation next to two alternatives that don't add a new vendor.**

Jev is good at fast (70–500 ms), cheap, schema-guaranteed classification. MARVIN's live per-turn paths are the only places where that speed would matter, and those are exactly the places MARVIN can't hand to a hosted, early-access, US-only model. The batch places where Jev would be safe (the nightly practice loop) don't need its speed.

Claude Haiku 4.5 with structured output runs through the Agent SDK auth MARVIN already uses and sends data to no one new. It scores as well as or better than Jev on every criterion except latency.

## 1. What Jev is (verified)

| Property | Fact | Confidence |
|---|---|---|
| Kind | A typed-decision model, **not** a text generator. Input is `state` plus questions. Output is a probability distribution over a closed set of answers. | high (3-0) |
| Question types | `noul` (yes/no → P(yes)), `choice` (up to **255** options, full distribution), `score` (a rubric of 2–10 levels, probability-weighted). Several questions per request, run in parallel over the same state. | high (3-0) |
| Training | "Reinforcement Learning for Calibrated Decisions" (RLCD). The calibration is **the vendor's claim only**. | high that it's claimed; unverified that it's true |
| API | `POST https://api.typesafe.ai/v1/systemone` with a Bearer key. Errors are 401/422/429/**529 overloaded**. Pin `jev-1.13.0`, because `jev-latest` changes without notice. | high (3-0) |
| SDK | **`@typesafe-ai/sdk` 0.6.0** (TypeScript, Node ≥ 20, MIT, SLSA provenance, about 11 days old). No Python needed. | high (3-0) |
| Limits | 64k tokens per request, of which **32k** for state plus the longest question. 1,200 requests/min and 250k tokens/s, adjusted "dynamically, without notice". | high (3-0) |
| Price | $0.042 per million input tokens. Output is free. | high (3-0) |
| Latency | Vendor quotes 70–500 ms. One independent measurement got 403 ms, **but 5 of 6 calls in a burst returned 529**. The only third-party production figure is 18× faster at p95, below the vendor's 40× lower bound. | medium (2-1) |
| "Can't hallucinate" | Means the output always **fits the schema**, not that it is **correct**. The vendor says its 0 % figure is "not empirical". | high (3-0) |
| Privacy | TypeSafe doesn't train on your inputs, but data can be used to "improve and debug" the service and is kept "as long as reasonably necessary". **Zero retention is enterprise-only.** Hosted on the US West Coast only, with **no offline or local option**. | high (3-0) |

## 2. Where MARVIN makes decisions Jev could make

These are the classification points in MARVIN today, located through the code graph:

| # | Decision point | Where | Mechanism today | Jev fit |
|---|---|---|---|---|
| U1 | **Tool-permission gate**: allow / confirm / deny | `classifyToolCall`, `sidecar/packages/runtime/src/sdk-runner.ts:957`; `toolPolicy` / `mcpToolPolicy` in `sidecar/packages/tools/src/policy.ts` | Deterministic ladder: hard-deny regexes, subagent `agentID` invariant, ADR-0117 provenance | ❌ **Poor.** See §4. |
| U2 | **Memory write content class**: fact vs activity / status / decision | `validateRememberPayload`, `sidecar/packages/runtime/src/memory-mcp.ts:132` (`BANNED_PATTERNS`) | Regex plus length caps | ⚠️ Possible, only as a **second opinion that can never reject on its own** |
| U3 | **Backlog write content class**: work vs fact / status / decision | `backlog-mcp.ts` (the enforced boundary, line 5) | Regex | ⚠️ Same as U2 |
| U4 | **Practice-loop transcript mining**: "user corrected MARVIN", "turn ended mid-plan with no question", "permission question the plan already granted" | `EXTRACTORS`, `practice-extractors.ts:1064`; `scoreFinding`, `practice.ts:673` | Deterministic extractors. ADR-0105 specifies **no model in the loop**. | ✅ **Best fit**, but it would amend ADR-0105's "no model" rule |
| U5 | **Dispatch routing**: e.g. remap a general-purpose dispatch to `graph-extractor` | `remapGraphExtractionDispatch`, `sdk-runner.ts:943` | Two regexes | ⚠️ Too small to justify a vendor |
| U6 | **Ship-review gate**: is this diff boundary-touching? | `checkShipReview`, `design-hooks.ts:~1537` | Path regex and line/file counts | ❌ Paths are already exact. A model adds noise. |

The only model call outside a turn today is `practice-draft.ts`, which drafts rule messages through the Agent SDK `query()` with the auditor's tool denylist. That is the precedent for the "Claude Haiku via the SDK" alternative below.

## 3. Weighted decision

Five options, each scored 1–5 per criterion. The weights reflect MARVIN's stated values: local-first (Golden Rule 4), gates over prose (ADR-0118), and measure first.

| Criterion | Weight | A. Status quo (regex only) | B. Jev, advisory, batch only, opt-in | C. Jev in the live gate / validators | D. Local classifier (ONNX encoder or SetFit via `onnxruntime-node`) | E. Claude Haiku 4.5 structured output via existing SDK auth |
|---|---:|:-:|:-:|:-:|:-:|:-:|
| Capability gain (semantic judgement regex can't make) | 20 | 1 | 4 | 3 | 3 | 4 |
| Privacy / no new data recipient | 20 | 5 | 3 ¹ | 1 | 5 | 4 ² |
| Safe when it fails (timeouts, 529s, wrong answers) | 15 | 5 | 4 | 1 | 4 | 4 |
| Independent evidence of accuracy | 15 | 3 | 2 | 1 | 3 | 3 |
| Vendor maturity / lock-in | 10 | 5 | 2 | 1 | 5 | 5 |
| Integration cost | 10 | 5 | 4 | 3 | 2 | 5 |
| Latency | 5 | 5 | 5 | 3 | 5 | 2 |
| Cost | 5 | 5 | 5 | 5 | 5 | 3 |
| **Weighted score (out of 5)** | | **3.90** | **3.40** | **1.90** | **3.85** | **3.90** |

¹ Opt-in per project, with secret redaction. Still a new third party, with non-enterprise retention undefined.
² Anthropic already receives every file and transcript MARVIN touches, so this adds no new recipient.

**What the scores show.** Jev's two real advantages, latency and cost, carry only 10 % of the weight between them. That's because every place where MARVIN *could* use Jev safely is a batch job, where latency doesn't matter and the volume is tiny, so cost doesn't either. The one place where latency does matter (U1, the live gate) is ruled out on safety and privacy grounds. Adopting Jev would only win if an offline evaluation showed it is clearly **more accurate** than E on MARVIN's own labels.

## 4. Why not the permission gate (U1)

- Claude Code's own model-based gate misses **17 %** of real over-eager actions (n=52), and **5.7 %** of synthetic exfiltration attempts, even with a second reasoning stage ([Anthropic](https://www.anthropic.com/engineering/claude-code-auto-mode)).
- AmPermBench (a stress test built around ambiguous permission cases) measured an **81 % false-negative rate** end to end. 36.8 % of actions never reached the classifier at all ([arXiv 2604.04978](https://arxiv.org/html/2604.04978v2)).
- The gate runs on every tool call. A hosted dependency that returned 529 on 5 of 6 burst calls would either stall turns (fail closed) or let calls through unchecked (fail open). Neither is acceptable for a safety boundary.
- Every Bash command, file path and edit would go to a third party.

MARVIN's rule since ADR-0118 is "a gate wherever a rule must hold regardless of what the model does." A probabilistic gate contradicts that by definition. At most, a model signal could **add friction** (escalate allow → confirm), never remove it. Even that isn't worth a new vendor.

## 5. Risks

| Risk | Severity | Mitigation if we go ahead |
|---|---|---|
| Code or transcripts sent to a new third party | High | Opt-in per project. Redact secrets before sending. Default off. Clear disclosure in the Settings UI. |
| Vendor is about 1–2 weeks old, SDK is pre-1.0, limits and prices change without notice | High | Pin `jev-1.13.0`. Wrap behind MARVIN's own function. No schema lock-in, because questions are plain data. |
| Availability (529 overloads) | Medium | Batch only. Exponential backoff. Fail open to the deterministic result. |
| No offline mode | Medium | Batch jobs skip the Jev step when offline. Never on a live path. |
| Calibration claim unverified | Medium | Phase 0 measures expected calibration error (ECE) on MARVIN's labels before anything relies on the confidence values. |
| 32k-token state limit | Low | Chunk transcripts per turn. The practice loop already works per turn. |
| Golden Rule 1 (model dispatching model) | Low | A classifier is not an agent: it has no tools and no autonomy. It still needs ADR-0120 and an ADR-0105 amendment. |

## 6. Proposed plan

The plan is gated: each phase ships only if the one before it passes its Definition of Done.

### Phase 0: offline evaluation (no product code; about 2–3 days)

Build `scripts/classifier-eval/`, a research harness outside the sidecar packages.

1. **Labelled sets from MARVIN's *own* repo transcripts** (not a user project's, which avoids the privacy question during the evaluation):
   - **T-mem** (U2/U3): about 200 real `remember` and `backlog_add` payloads, labelled `fact | activity | status | decision | work`.
   - **T-practice** (U4): about 300 user turns, labelled `correction | redirect | approval | new-ask | other`.
2. Run four classifiers on both sets: A (current regex / extractor), E (Haiku 4.5 via SDK `query()` with a JSON schema), B (Jev `choice`, with the user's explicit consent to send MARVIN's own transcripts), and D (a small ONNX encoder, if time allows).
3. Report macro-F1, ECE (calibration), p50/p95 latency, error/529 rate, and cost per 1k items.

**Definition of Done:**
- Both labelled sets exist, with the labelling rules written down.
- A single command reproduces the comparison table.
- The table covers at least A, E and B on both sets.
- A written verdict names which classifier, if any, beats A by at least 10 F1 points on either set.

**Decision gate.** Jev proceeds only if it beats E by at least 5 F1 points *or* has an ECE clearly better than E's, and the user accepts the privacy trade-off. Otherwise Phase 1 uses E, or stops if neither beats A.

### Phase 1: advisory semantic extractors in the practice loop (U4)

- Write **ADR-0120**, amending ADR-0105's "no model in the loop" to "no model *deciding*". A classifier may **nominate** findings, and the existing scoring and the user's approval still decide. This is off by default and opt-in per project (the Practice pane).
- Keep it to a single function, `classifyTurns(turns, labels)`, with the winning backend behind it. Add a provider interface only if a second backend actually ships (the simplicity rule: no abstraction with one call site).
- Fail open: on a timeout (800 ms per call), a 429/529, or no network, skip the classifier and run the deterministic extractors as they are today.
- If the winning backend is Jev, store the key in the Keychain (never `.marvin/`) and redact secrets from `state` before sending.

**Definition of Done:**
- A project with the setting off behaves byte-identically to today (tested).
- With it on, the new finding kinds appear in the Practice pane with their confidence.
- A forced 529 or timeout still completes the nightly pass (tested).
- ADR-0120 is accepted.

### Phase 2 (only if Phase 1 findings prove useful after about 2 weeks): second opinion on memory and backlog writes (U2/U3)

The regex stays the enforcer. The classifier may only **append a warning** to the tool result ("this reads like status (p=0.91)"). It never rejects. Log agreement with the regex, and promote to a reject only by a later ADR, based on measured precision.

### Not planned

- U1 (permission gate): see §4.
- U5 and U6: deterministic inputs where a model adds variance without adding value.
- Any live per-turn use of Jev.

## 7. Open questions

1. What retention period applies to non-enterprise accounts, and is zero retention available to individuals? (The DPA was not reviewed.)
2. What are p95 latency and the 529 rate from outside the US?
3. Is an on-device or self-hosted Jev planned? That would remove the privacy and offline blockers, and change the scores in §3.
4. What SLA and deprecation policy apply to pinned model versions during early access?

## Sources

Primary: [announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev) · [API](https://docs.typesafe.ai/api.md) · [models and limits](https://docs.typesafe.ai/models) · [JS SDK](https://docs.typesafe.ai/sdk/javascript.md) · [legal](https://docs.typesafe.ai/legal.md) · [privacy policy](https://typesafe.ai/legal/privacy-policy) · [Anthropic: Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) · [AmPermBench, arXiv 2604.04978](https://arxiv.org/html/2604.04978v2) · [constrained decoding and accuracy, arXiv 2609.23742](https://arxiv.org/html/2609.23742) · [encoders vs LLMs, arXiv 2602.06370](https://arxiv.org/html/2602.06370v1) · [SetFit](https://huggingface.co/docs/setfit/conceptual_guides/setfit) · [XGrammar](https://blog.mlc.ai/2024/11/22/achieving-efficient-flexible-portable-structured-generation-with-xgrammar)

Secondary: [MarkTechPost](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/) · [DataCamp](https://www.datacamp.com/blog/system-one-models-jev) · [HN thread](https://news.ycombinator.com/item?id=49717558) · [TrueFoundry](https://www.truefoundry.com/blog/typesafe-ai-jev)

Refuted in verification and excluded: XGrammar's "3.5×/10× mask speedup" (1-2), and "SetFit matches RoBERTa-Large with 8 examples per class" (0-3).
