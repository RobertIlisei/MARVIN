/**
 * Regression coverage for the firm surfaces in `personality.ts` (ADR-0077).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `personality.ts` is 1800+ lines of behavioural contract and was, until this
 * file, the single largest piece of MARVIN with ZERO test coverage — 98 test
 * files, none of them touching the prompt. That is the worst possible place
 * for a coverage hole, because every firm surface in it was written in
 * response to a measured failure:
 *
 *   - the 2026-05-22 skill audit (5 of 6 skills had soft-nudge language and
 *     fired ~0x across thousands of qualifying contexts),
 *   - the 2026-05-27 graphify audit (~7:1 file-ops to graph-ops drift),
 *   - ADR-0067 (33.1 h of a 49 h session spent waiting on the user),
 *   - ADR-0068 (a real plan reported as "fabricated"),
 *   - ADR-0042 (a 419 KB memory.md that overflowed the context window).
 *
 * Each of those cost real debugging time to find, and each fix is a block of
 * prose that a future edit can silently delete. Nothing would fail. The next
 * audit would rediscover the same drift months later.
 *
 * Anthropic's AI-native SDLC playbook prescribes "continuous evals in CI" for
 * exactly this: regression-test the agent's *configuration*, not just its code.
 * This is the deterministic half of that — it asserts the contract is PRESENT
 * and INTERNALLY CONSISTENT, which is free and runs on every push. It does not
 * assert the model OBEYS the contract; that needs a behavioural harness and a
 * budget, and is deliberately out of scope here (see ADR-0077 "Alternatives").
 *
 * WHEN THIS FAILS
 * ---------------
 * Do NOT delete the assertion to make it green. Either restore the surface, or
 * — if the surface was removed on purpose — update this file IN THE SAME
 * COMMIT with the ADR that sanctions the removal. That is the whole point.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildSystemPrompt, type PersonalityMode } from "../src/personality";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");

const MODES: PersonalityMode[] = ["marvin", "neutral", "ultron"];
const PROMPTS = Object.fromEntries(
  MODES.map((m) => [m, buildSystemPrompt(m)]),
) as Record<PersonalityMode, string>;

/** The prompt every mode shares. Persona is a style layer, not a rule layer. */
const prompt = PROMPTS.ultron;

describe("personality — the firm surfaces are present in every mode", () => {
  // The table in CLAUDE.md ("The firm surfaces") is the human-facing index of
  // these. If a row is added there, add it here too — a documented rule with
  // no prompt section is exactly the drift this catches.
  const SURFACES: ReadonlyArray<readonly [string, RegExp]> = [
    ["ground truth block", /## GROUND TRUTH/],
    ["non-negotiable rules", /NON-NEGOTIABLE rules/],
    ["simplicity + surgical edits", /## Simplicity first/],
    ["autonomy mode (ADR-0036)", /## Autonomy mode/],
    ["negative claims (ADR-0068)", /is NOT "it does not exist"/],
    ["found-plan vs active-plan (ADR-0068)", /A plan you FOUND is not a plan you are ON/],
    ["the 8 phases", /## The 8 phases/],
    ["deterministic ADR triggers", /## Deterministic ADR triggers/],
    ["ADR template", /## Scope of Done/],
    ["advisor protocol (ADR-0007)", /## Advisor protocol/],
    ["graphify protocol", /## Graphify protocol/],
    ["per-tool MUST triggers", /### Per-tool MUST triggers/],
    ["scout protocol (ADR-0014)", /## Scout protocol/],
    ["dynamic workflows (ADR-0030)", /## Dynamic workflows/],
    ["skill triggers", /## Skill triggers/],
    ["browser tools", /## Browser tools/],
    ["project memory (ADR-0042)", /## Project memory/],
    ["project backlog (ADR-0044)", /## Project backlog/],
  ];

  it.each(MODES)("mode %s carries every firm surface", (mode) => {
    const missing = SURFACES.filter(([, re]) => !re.test(PROMPTS[mode])).map(([n]) => n);
    expect(missing).toEqual([]);
  });

  it("persona is a style layer only — the rule surfaces are byte-identical across modes", () => {
    // If a rule ever diverges by persona, a user flipping the personality chip
    // silently changes what MARVIN is allowed to do. That is a bug, not a
    // feature: CLAUDE.md says the persona "is a style layer, not a refusal
    // layer".
    const rulesOf = (p: string) => p.slice(p.indexOf("## Core behavior"));
    expect(rulesOf(PROMPTS.marvin)).toBe(rulesOf(PROMPTS.neutral));
    expect(rulesOf(PROMPTS.ultron)).toBe(rulesOf(PROMPTS.neutral));
  });
});

describe("personality — every graph_* tool has a MUST trigger", () => {
  // The 2026-05-27 audit root cause: `graph_search` was used as a glorified
  // grep while `graph_summary` / `graph_query` / `graph_save_result` were
  // near-zero, because only some tools had an enumerated trigger. A new graph
  // tool shipped without one regresses straight back to that.
  const GRAPH_TOOLS = [
    "graph_summary",
    "graph_query",
    "graph_affected",
    "graph_neighbors",
    "graph_path",
    "graph_search",
    "graph_save_result",
    "graph_reflect",
  ];

  it.each(GRAPH_TOOLS)("%s has a MUST heading", (tool) => {
    expect(prompt).toMatch(new RegExp(`${tool}\\\\?\`?\\s*(—|-)\\s*MUST`));
  });

  it("keeps the cross-tool MUST-NOT block", () => {
    expect(prompt).toMatch(/### Cross-tool MUST-NOTs/);
  });
});

describe("personality — skill triggers stay deterministic", () => {
  // 2026-05-22 audit: soft-nudge language ("consider using…") fired ~0x.
  // Every skill section must carry a hard MUST, and the skill must actually
  // be installed in the repo or available from the shared bundle.
  const SKILLS = [
    "test-driven-development",
    "systematic-debugging",
    "pr-review",
    "security-audit",
    "frontend-design",
    "graphify",
  ];

  it.each(SKILLS)("%s has a section that is deterministic, not a nudge", (skill) => {
    const idx = prompt.indexOf(`### Skill: \`${skill}\``);
    expect(idx, `no section for ${skill}`).toBeGreaterThan(-1);
    // Read to the next `###` heading; the trigger must be inside this section,
    // not merely somewhere in the 1800-line prompt.
    const rest = prompt.slice(idx + 1);
    const end = rest.indexOf("\n### ");
    const section = end === -1 ? rest : rest.slice(0, end);
    // A section satisfies the contract one of two ways: it states its own
    // MUST, or it explicitly defers to a named rule that carries one.
    // `graphify` takes the second path on purpose — Golden Rule 7 and the
    // Graphify protocol already govern it, and restating a rule in two places
    // is how the two versions drift apart.
    const deterministic =
      /\bMUST\b/.test(section) ||
      /(Already governed by|defer to that section)/i.test(section);
    expect(
      deterministic,
      `${skill}: neither a MUST nor an explicit deferral — this is the ` +
        `soft-nudge shape the 2026-05-22 audit found firing ~0x`,
    ).toBe(true);
  });

  it("names no skill that the repo does not vendor or document", () => {
    // The four MARVIN-adopted skills are vendored; the rest come from the
    // shared bundle via install-skills.sh. A skill named in the prompt but
    // absent from both is an instruction MARVIN cannot follow.
    const vendored = readFileSync(
      path.join(REPO_ROOT, "scripts/install-skills.sh"),
      "utf8",
    );
    const claudeMd = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
    for (const skill of SKILLS) {
      const known =
        vendored.includes(skill) ||
        claudeMd.includes(skill) ||
        // vendored under .claude/skills/
        skill === "graphify";
      expect(known, `${skill} is named in the prompt but not installable`).toBe(true);
    }
  });
});

describe("personality — cross-file consistency", () => {
  it("every ADR the prompt cites exists on disk", () => {
    // ADR-0068's lesson generalised: a citation that does not resolve is a
    // negative claim waiting to happen. Cheap to check, and it catches an ADR
    // renamed or renumbered without a corresponding prompt update.
    const cited = [...prompt.matchAll(/ADR-(\d{4})/g)]
      .map((m) => m[1])
      .filter((n): n is string => typeof n === "string");

    expect(
      new Set(cited).size,
      "prompt cites no ADRs — did the citations get stripped?",
    ).toBeGreaterThan(10);

    const onDisk = readdirSync(path.join(REPO_ROOT, "docs/decisions"));
    const missing = [...new Set(cited)]
      .filter((n) => !onDisk.some((f) => f.startsWith(`${n}-`)))
      .sort();
    expect(missing, `prompt cites ADRs with no file: ${missing.join(", ")}`).toEqual([]);
  });

  it("every sanctioned subagent_type is described in the prompt", () => {
    // The gate auto-allows these without a confirm card. If the prompt does
    // not tell MARVIN what they are for, the allowlist is wider than the
    // documented contract — which is how an escalation surface opens.
    for (const sub of ["scout", "advisor", "graph-extractor"]) {
      expect(prompt, `sanctioned subagent "${sub}" is undocumented in the prompt`)
        .toContain(sub);
    }
  });

  it("the anti-multi-agent invariant is stated, not implied", () => {
    // Golden Rule 1. Parallel *implementation* is the failure this exists to
    // prevent; the read-only carve-outs are the only exceptions.
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toMatch(/MUST NOT|never/i);
  });
});
