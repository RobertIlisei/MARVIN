/**
 * Regression coverage for MARVIN's system prompt (ADR-0077, reshaped by
 * ADR-0118 Milestone 3).
 *
 * Until 2026-09-21 this file asserted that the prompt carried an enumerated
 * MUST trigger for every graph tool and skill. The prompt was rewritten from
 * 29.4K to ~4K tokens: rules a gate enforces are stated once, occasional
 * procedures became on-demand skills (`core-skills.ts`, invoked `marvin:*`),
 * and memory / backlog content rules live in the tool descriptions that
 * enforce them. So the contract this file guards changed shape:
 *
 *   1. every format the app PARSES out of the model's output is still taught,
 *      verbatim (plan heading, step tags, scope-met marker, advisor prefix);
 *   2. every rule that left the prompt still lives somewhere loadable — a
 *      core skill, a tool description — never nowhere;
 *   3. every `marvin:` pointer resolves to a skill MARVIN ships;
 *   4. the prompt stays small (the re-bloat guard) and persona stays a style
 *      layer.
 *
 * WHEN THIS FAILS: restore the surface, or change this file in the same commit
 * as the ADR that sanctions the removal.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CORE_SKILLS } from "../src/core-skills";
import { buildSystemPrompt, type PersonalityMode } from "../src/personality";
import { SCOPE_MET_SENTINEL } from "../src/workflow-guard";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const SRC = (f: string) => readFileSync(path.join(HERE, "../src", f), "utf8");

const MODES: PersonalityMode[] = ["marvin", "neutral", "ultron"];
const PROMPTS = Object.fromEntries(MODES.map((m) => [m, buildSystemPrompt(m)])) as Record<PersonalityMode, string>;
const prompt = PROMPTS.ultron;

describe("personality — shape", () => {
  const SECTIONS = [
    "## Ground truth",
    "## How you work",
    "### Scope boundaries",
    "## Plans and task lists",
    "## Honesty",
    "## Writing code",
    "## Subagents",
    "## Memory, backlog and vault",
    "## Skills",
  ];

  it.each(MODES)("mode %s carries every section", (mode) => {
    expect(SECTIONS.filter((s) => !PROMPTS[mode].includes(s))).toEqual([]);
  });

  it("persona is a style layer only — the rules are byte-identical across modes", () => {
    const rulesOf = (p: string) => p.slice(p.indexOf("## How you work"));
    expect(rulesOf(PROMPTS.marvin)).toBe(rulesOf(PROMPTS.neutral));
    expect(rulesOf(PROMPTS.ultron)).toBe(rulesOf(PROMPTS.neutral));
  });

  it.each(MODES)("mode %s stays under the 8K-token budget (the re-bloat guard)", (mode) => {
    // 29.4K tokens was the pre-ADR-0118 size; a fresh agri-saas-platform tab
    // started at 71 % of its window partly because of it.
    expect(Math.round(PROMPTS[mode].length / 3.6)).toBeLessThan(8000);
  });
});

describe("personality — formats the app parses are taught verbatim", () => {
  it.each([
    ["plan heading (PlanParser, the Plan card)", "`# Plan — <title>`"],
    ["step tags (the plan spine's join key)", "`[N]`"],
    ["sub-task tags", "`[N.M]`"],
    ["TodoWrite full-list rewrite (ADR-0046)", "**full rewrite**"],
    ["plan file ownership (gate deny, ADR-0052)", "`.marvin/plans/`"],
    ["scope-met handoff line", "**Scope met:**"],
    ["scope-met marker (workflow guard, Swift ScopeMetDetector)", SCOPE_MET_SENTINEL],
    ["advisor description prefix (UI orb)", 'description: "advisor: <topic>"'],
  ])("%s", (_name, needle) => {
    expect(prompt).toContain(needle);
  });
});

describe("personality — rules that left the prompt still live somewhere", () => {
  it("every graph tool is documented in marvin:graph-tools", () => {
    for (const tool of [
      "graph_summary", "graph_query", "graph_affected", "graph_change_impact",
      "graph_path", "graph_neighbors", "graph_search", "graph_community",
      "graph_save_result", "graph_reflect",
    ]) {
      expect(CORE_SKILLS["graph-tools"], tool).toContain(tool);
    }
  });

  it("the ADR triggers and template live in marvin:adr", () => {
    expect(CORE_SKILLS.adr).toContain("## Scope of Done");
    expect(CORE_SKILLS.adr).toContain("Supersedes ADR-NNNN");
    expect(CORE_SKILLS.adr).toContain("re-derivation test");
  });

  it("the browser MCP-vs-CLI choice lives in marvin:browser", () => {
    expect(CORE_SKILLS.browser).toContain("browser_run_code_unsafe");
    expect(CORE_SKILLS.browser).toContain("npx --package=playwright");
  });

  it("the semantic graph pass keeps its graph-extractor fan-out rules", () => {
    expect(CORE_SKILLS["graph-tools"]).toContain('subagent_type: "graph-extractor"');
    expect(CORE_SKILLS["graph-tools"]).toMatch(/in \*\*one\*\* message/);
  });

  it("memory and backlog content rules are enforced by their tool descriptions", () => {
    expect(SRC("backlog-mcp.ts")).toMatch(/NOT\s+"?\s*\+?\s*"?for durable facts/);
    expect(SRC("backlog-mcp.ts")).toContain("provisional: true");
    expect(SRC("memory-mcp.ts")).toContain('"remember"');
  });
});

describe("personality — pointers resolve", () => {
  const INJECTED = [
    readFileSync(path.join(REPO_ROOT, "sidecar/packages/project-context/src/workflow-health.ts"), "utf8"),
    readFileSync(path.join(REPO_ROOT, "sidecar/packages/project-context/src/fingerprint.ts"), "utf8"),
  ];

  it("every marvin:<skill> named in the prompt or an injected block is a shipped core skill", () => {
    const named = new Set(
      [prompt, ...INJECTED].flatMap((t) => [...t.matchAll(/`marvin:([a-z-]+)`/g)].map((m) => m[1] as string)),
    );
    expect(named.size).toBeGreaterThan(0);
    expect([...named].filter((n) => !(n in CORE_SKILLS))).toEqual([]);
  });

  it("every core skill is reachable from the prompt — none shipped and never mentioned", () => {
    expect(Object.keys(CORE_SKILLS).filter((n) => !prompt.includes(`marvin:${n}`))).toEqual([]);
  });

  it("every third-party skill the prompt names is installable", () => {
    const install = readFileSync(path.join(REPO_ROOT, "scripts/install-skills.sh"), "utf8");
    const claudeMd = readFileSync(path.join(REPO_ROOT, "CLAUDE.md"), "utf8");
    for (const skill of ["test-driven-development", "systematic-debugging", "pr-review", "security-audit", "frontend-design", "graphify"]) {
      expect(prompt, `${skill} missing from the prompt`).toContain(`\`${skill}\``);
      expect(install.includes(skill) || claudeMd.includes(skill), `${skill} is not installable`).toBe(true);
    }
  });

  it("every ADR cited by the prompt or a core skill exists on disk", () => {
    const text = [prompt, ...Object.values(CORE_SKILLS)].join("\n");
    const cited = [...new Set([...text.matchAll(/ADR-(\d{4})/g)].map((m) => m[1] as string))];
    const onDisk = readdirSync(path.join(REPO_ROOT, "docs/decisions"));
    expect(cited.filter((n) => !onDisk.some((f) => f.startsWith(`${n}-`)))).toEqual([]);
  });
});

describe("personality — Golden Rule 1", () => {
  it("every sanctioned subagent_type is described", () => {
    for (const sub of ["advisor", "scout", "implementer", "graph-extractor"]) {
      expect(prompt, sub).toContain(`subagent_type: "${sub}"`);
    }
  });

  it("the single-assistant invariant is stated, not implied", () => {
    expect(prompt).toContain("You are a single assistant");
    expect(prompt).toMatch(/none of them may change the main working tree/);
    expect(prompt).toMatch(/Never parallel implementation/);
  });
});
