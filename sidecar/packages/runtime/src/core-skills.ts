/**
 * MARVIN's own skills (ADR-0118 Milestone 3).
 *
 * Procedures that used to sit in every turn's system prompt — ADR writing,
 * graph-tool reference, browser verification, skill and workflow audits, the
 * greenfield playbook — load on demand instead. They ship WITH MARVIN, not
 * through `install-skills.sh` (which never updates an installed skill): the
 * runtime writes them under the data dir as a local plugin named `marvin`, so
 * the text always matches the running version and the prompt's pointers
 * (`marvin:adr`, …) always resolve. Edit the text here; the files are output.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getMarvinDataDir } from "./paths";

/** Plugin name — skills are invoked as `marvin:<skill>`. */
export const CORE_SKILLS_PLUGIN = "marvin";

export const CORE_SKILLS: Readonly<Record<string, string>> = {
  "adr": `---
name: adr
description: Decide whether a change needs an Architecture Decision Record and write one. Use when a change is foundational (framework, runtime, platform, auth provider, deployment target), changes a public API shape, a persistent-state schema or a security boundary, swaps a default model or runtime mode, registers an MCP server, sets a cross-cutting constraint, supersedes an existing ADR, or when the user calls it an ADR.
---

# Architecture Decision Records

## When an ADR is required

Write one when any of these holds:

1. A foundational framework, runtime or platform changes (web framework, ORM, queue, auth provider, deployment target, package manager).
2. A public API shape changes: a new endpoint category, a changed envelope, a removed or renamed field, changed status-code semantics, renamed event names.
3. A persistent-state schema changes (stored files the code reads, user config, database migrations).
4. A security boundary changes: auth flow, credential handling, tool-permission policy, a confirm gate, a file sandbox, a shell allow-list, network egress.
5. A default model or runtime mode changes.
6. A new MCP server is registered — each one is a trust boundary and a policy surface.
7. A cross-cutting constraint is introduced ("all writes go through the event bus", "migrations stay backward-compatible for one release").
8. An existing ADR is superseded or deprecated: write a new one that says \`Supersedes ADR-NNNN\` and update the old one's status.
9. The user names the decision as material ("this is an ADR", "worth an ADR").

Do not write one for typos, lint or formatter changes, an internal refactor with no contract change, trivially obvious choices, regenerated artefacts or lockfile bumps, or documentation that encodes no new constraint.

When unsure, apply the re-derivation test: eight weeks from now, would someone reading only the code and the commit messages reach the same conclusion? If not, write the ADR.

## Where and how

ADRs live in the project's ADR directory (\`docs/adr/\`, \`docs/adrs/\` or \`docs/decisions/\`), numbered one above the highest existing number: \`NNNN-short-title.md\`. Never reuse a number.

\`\`\`markdown
# NNNN — <decision title>

- Status: accepted | superseded by NNNN | deprecated
- Date: YYYY-MM-DD

## Context
Why the decision was needed and what constrains it — specific enough that a
reader eight weeks from now understands the situation without re-deriving it.

## Decision
What was chosen, in one clear sentence, then supporting bullets.

## Consequences
- Positive: …
- Negative / trade-offs: …
- Follow-ups created: …

## Alternatives considered
- Option A — why rejected.

## Scope of Done
3–5 falsifiable bullets: what implementing this decision specifically means.
Anything noticed but not listed becomes a follow-up, not a silent expansion.

## Related
- Files, graph nodes, superseded ADRs.
\`\`\`

## Before showing it

Ask the advisor to read it cold: dispatch \`Agent\` with \`subagent_type: "advisor"\` and a prompt like "You are reading this ADR eight weeks from now, about to make a related change. List every question it leaves unanswered that would make you ask the user again." Close the gaps it finds, then present the ADR and wait for the user's approval before planning the implementation.

When the work is done, tick the \`## Scope of Done\` bullets that actually happened — honestly; an unticked box is better than a false one.
`,
  "graph-tools": `---
name: graph-tools
description: How to use MARVIN's knowledge-graph tools well — which graph_* tool answers which question, scopes, the honesty signals in their output, recording outcomes, and building or fixing a project's graph (the semantic pass with graph-extractor subagents, .graphifyignore). Use when a graph answer looks wrong or thin, before a semantic /graphify pass, when a project has no graph or a noisy one, or when unsure which graph tool fits.
---

# Graph tools

Each project has two graphs: the **code graph** (\`graphify-out/graph.json\`, AST extraction, rebuilt automatically) and the **knowledge graph** (\`graphify-out/knowledge/graph.json\`, headings and links across docs, ADRs and memory; rebuild with \`bin/marvin knowledge-graph .\`). Every tool takes \`scope: "code" | "knowledge" | "all"\`; code is the default. Use \`knowledge\` for "what does ADR-N say" or "where is X documented", \`all\` when the question spans both or you do not know which holds the answer.

## Which tool

| Question | Tool |
|---|---|
| Orient at the start of non-trivial work | \`graph_summary({scope: "all"})\` — god nodes and communities show the shape of the codebase |
| How does X work / why does X exist | \`graph_query({question, scope})\` — the backend walks the graph for you; chaining search → neighbors by hand costs more and answers worse |
| What breaks if I change X / who calls X / is X dead | \`graph_affected({symbol, depth})\` — directed callers with file and line; run it before modifying, renaming or deleting a symbol |
| What does this branch or diff touch | \`graph_change_impact()\` — no arguments compares the branch with its base; read god nodes first, then external callers (the review's priority order), then how many communities it spreads across |
| How does X reach Y | \`graph_path({from, to, relations: ["calls", "imports", "imports_from", "method", "contains"]})\` — the hops are the files a vertical slice touches |
| What is near X (imports, containment) | \`graph_neighbors\` — undirected, so it cannot tell a caller from a callee; never use it as a blast radius |
| Resolve a name to a node | \`graph_search\` — a lookup, not an answer; three searches in a row means you wanted \`graph_query\` |
| Members of one community | \`graph_community\` |

Answer architectural questions from the graph plus the cited \`source_file\`s, not from memory. Say "inferred" for INFERRED edges and read the file for AMBIGUOUS ones.

## Honesty signals

- **Ambiguous name** from \`graph_affected\`: the name is common (\`parse\`, \`get\`), so the hits include unrelated symbols. Narrow it; never report that count as a blast radius.
- **No callers found** is not proof of dead code: entry points, dynamic dispatch and reflection look the same. Confirm before deleting.
- An empty \`graph_change_impact\` on a branch with no diff means nothing changed, not that a change is safe.

## Record outcomes

After a graph answer you acted on, call \`graph_save_result({question, answer, outcome, scope, nodes})\`:
- \`useful\` — you read the source and the answer held up;
- \`dead_end\` — the graph did not contain it and you fell back to reading files;
- \`corrected\` — the answer was wrong; pass \`correction\` with what was true. This is the most valuable signal there is.

\`graph_reflect({scope})\` folds saved outcomes into \`graphify-out/reflections/LESSONS.md\`. Run it before structural work in an area where the graph misled you before, and after recording three or more outcomes in a session.

## Missing or stale graphs

- No code graph: tell the user and recommend \`/graphify .\` before going further.
- No knowledge graph: recommend \`bin/marvin knowledge-graph .\` (free).
- Stale: \`/graphify . --update\` for code, \`bin/marvin knowledge-graph .\` for knowledge.

## A project's first graph: write \`.graphifyignore\`

A graph that includes build output, caches and vendored code produces god nodes like \`string\` instead of the real anchors. Before the first \`/graphify .\`:

1. Look at the root (\`ls -la\`, \`du -sh */\`) and find large directories that are not first-party code.
2. Propose ignore patterns for the noise graphify does not skip itself: framework build dirs (\`.next/\`, \`.turbo/\`, \`.svelte-kit/\`, \`.build/\`, \`DerivedData/\`, \`.gradle/\`), vendored code (\`vendor/\`, \`third_party/\`, \`Vendored/\`), test **outputs** (\`coverage/\`, \`playwright-report/\`, \`*.snap\`) — never test code — logs, binaries, minified and generated files, runtime state directories.
3. Show the proposed file and wait for the user's confirmation.
4. Write it (gitignore syntax, comments on their own line), run \`/graphify .\`, and check that the top \`source_file\`s in \`graph_summary\` are first-party code; if not, add patterns and rebuild.

graphify already skips \`node_modules\`, \`__pycache__\`, \`.git\`, virtualenvs, \`dist\`, \`build\`, \`target\`, \`out\`, tool caches, lockfiles and secret-looking files — do not re-list them.

## The semantic pass: fan out cheaply

The LLM-based \`/graphify\` pass over docs is slow run serially. When running it:

1. Dispatch each chunk as \`Agent\` with \`subagent_type: "graph-extractor"\` — the low-cost worker whose writes the gate confines to \`graphify-out/\`. Prefer it over \`general-purpose\` even where the graphify skill says otherwise; it has exactly the write access that step needs.
2. Put every chunk's \`Agent\` call in **one** message. Dispatching one, waiting, then the next makes the fan-out sequential.
3. Have each subagent write its own \`graphify-out/.graphify_chunk_NN.json\` and return only counts. Do not ask it for JSON and write the file yourself — that funnels every payload back through your context.

This is a scoped carve-out for building the graph, not permission for write-capable subagents elsewhere.
`,
  "browser": `---
name: browser
description: Drive a browser to verify web UI work — choosing between the Playwright MCP tools and the Playwright CLI, the three CLI shapes (screenshot, scripted check, test suite), and fixes for the common errors. Use for visual verification after UI changes, end-to-end flow checks, or debugging "doesn't work on my machine" reports.
---

# Browser verification

## MCP or CLI

The Playwright MCP tools (\`mcp__playwright__browser_*\`) exist only when the user enabled the server; if they are not in your tool list, use the CLI and do not report the MCP as broken. They are gated: observation runs, interaction and navigation confirm in gated mode, and \`browser_run_code_unsafe\` is denied.

Use the **MCP** when the check involves interaction (click, type, fill, upload, key press, navigation past the first load), when you must assert state after an interaction, when you need to read the page between steps, or when debugging a failure that lives in dynamic state.

Use the **CLI** only for a single static screenshot, for running the project's existing \`@playwright/test\` suite, or when the MCP is absent. If the browser must stay open across more than one action, it is the MCP.

## CLI shapes

**1. Screenshot only**

\`\`\`bash
npx -y playwright screenshot --browser=chromium \\
  --wait-for-selector='main' --full-page --viewport-size=1280,800 \\
  http://localhost:3000 /tmp/out.png
\`\`\`

Useful flags: \`--device='iPhone 14'\`, \`--wait-for-timeout=2000\`, \`--load-state=networkidle\`.

**2. Scripted check** — write the script to a file, then run it through npx so the \`playwright\` package resolves:

\`\`\`js
// /tmp/check.mjs
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3000');
await page.waitForSelector('main');
console.log('title:', await page.title());
await page.screenshot({ path: '/tmp/out.png', fullPage: true });
await browser.close();
\`\`\`

Run: \`npx --package=playwright -- node /tmp/check.mjs\`. Import from \`playwright\` (the library), not \`@playwright/test\`, and do not write \`test(...)\` blocks for a one-off check.

**3. The project's suite** — \`npx playwright test\`, only when \`playwright.config.{ts,js}\` exists. New tests go in the project's tests directory, not \`/tmp\`.

## Common errors

| Symptom | Fix |
|---|---|
| \`Executable doesn't exist at .../chromium-…\` | \`npx playwright install chromium\` |
| \`Cannot find package 'playwright'\` running \`/tmp/check.mjs\` | run via \`npx --package=playwright -- node /tmp/check.mjs\` |
| \`net::ERR_CONNECTION_REFUSED\` | the dev server is not up; start it first |
| Timeout waiting for a selector | take a full-page screenshot to see what actually rendered |
| \`require is not defined in ES module scope\` | use \`import\`; \`.mjs\` is ESM |

Do not loop screenshots to see whether a page loaded (wait for a selector), do not \`npm install playwright\` into the user's project to make a \`/tmp\` script work, and do not inline Playwright code in a \`Bash -c\` heredoc.
`,
  "skill-audit": `---
name: skill-audit
description: Recommend the skills a project should install or build, from its fingerprint tags. Use when a "## Skill audit pending" block is in your context, or when the user asks which skills to install, to audit skills for the project, or to build a skill for it.
---

# Skill audit

The injected \`## Project fingerprint\` block carries namespaced tags (\`framework:spring-boot\`, \`architecture:multi-tenant\`, \`compliance:gdpr\`, \`test:playwright\`, …). Use those tags as the input — do not re-derive the stack by reading manifests again.

## Two verbs, never mixed

- **Install** — for \`language:*\`, \`framework:*\`, \`test:*\`, \`build:*\` and \`module-system:*\` tags. These map to general-purpose skills in \`~/.claude/skills/\`, a once-per-machine action by the user. Example: \`test:playwright\` → install \`webapp-testing\`.
- **Build / edit** — for \`architecture:*\`, \`domain:*\`, \`compliance:*\`, \`workflow:*\` and \`integration:*\` tags. These are project-shaped skills that belong in \`<workDir>/.marvin/skills/\`, committed and reviewed with the repo. Example: \`architecture:spring-modulith\` → build \`spring-modulith-architecture\`.

A project-shaped skill cannot be "installed" — it has to be built first. A general skill that already exists (like \`pdf\`) should not be "built" for one project.

## Shape of the recommendation

One short block, under about twelve lines: the tags you used, an **Install** list and a **Build/edit** list, each item with one line on why. End by offering to walk through one or to record the decision in \`.marvin/skills.md\`. Then stop — do not start installing or building.

## Closing the loop

- When the user parks it, ask them to write a one-line \`<workDir>/.marvin/skills.md\` (even "audited 2026-MM-DD; parked all"). The file's existence removes the pending block next session.
- When they ask to build one of the project skills, invoke \`skill-creator\`, seeded with the fingerprint tags; the skill lands at \`<workDir>/.marvin/skills/<name>/SKILL.md\` and goes through skill-creator's evaluation loop before it counts as done.

## When not to run one

- The fingerprint reports \`hasSubstance: false\` (an empty repository).
- \`.marvin/skills.md\` already exists — unless the user asks again.
- The user is mid-task on a concrete, small ask — finish that first; the block is a standing reminder.
- You already produced the recommendation earlier this session. Once per session.
`,
  "workflow-audit": `---
name: workflow-audit
description: Catch up an in-flight project that is missing workflow deliverables (ADRs, project memory, a knowledge graph). Use when a "## Workflow health" block is in your context, or when the user asks to audit the project, re-check it against the workflow, or review what is missing.
---

# Workflow audit

The \`## Workflow health\` block re-appears every turn while the gaps exist on disk. It is a standing reminder, not a command to re-audit every turn. Pick the mode from what has already happened in this conversation.

## Mode A — first audit in this conversation: propose, then stop

1. **Find the decisions already made** by reading the repository itself: dependency manifests, build and deploy config, source layout, environment schemas, CI. Infer strictly from what is there; assume no particular technology.
2. **Propose one ADR per one-way-door decision**, named in the project's own terms, with a one-line summary each. Do not write the files yet.
3. **Graph status** — none: recommend \`/graphify .\`; stale: recommend \`/graphify . --update\`.
4. **Memory status** — if \`.marvin/memory.md\` is absent or empty, propose the first durable facts.
5. Stop and wait for the user.

## Mode B — already proposed, and the user continues: execute

"Proceed", "go ahead", "write them", and ambiguous continuations like "keep going" or "what's next?" all mean close the gaps — not re-audit.

1. Write each proposed ADR (use the \`marvin:adr\` skill for the template), numbered from the highest existing number plus one.
2. Record durable facts the decisions surfaced with \`remember\` — facts, not the decisions themselves, which live in the ADRs.
3. Run \`/graphify .\` (or \`--update\`). If it is not available, say so rather than skipping it.
4. Summarise what landed in a few lines, then return to the user's original ask, or continue into it if they implied that.

## Mode C — the user defers

If the user says "skip the audit" or "just do X", say in one line that the audit is deferred and do their ask. The block keeps appearing until the gaps close; that is expected.

## Never

- Re-propose ADRs you already proposed in this conversation.
- Write an ADR at a number that already exists.
- Silently skip \`/graphify\` when it is available.
`,
  "greenfield": `---
name: greenfield
description: Discovery and lock-in analysis for a project started from an empty or nearly empty repository. Use when the user starts a new project from scratch, or asks to choose a stack, framework, runtime or architecture for one.
---

# Greenfield projects

Foundational choices in an empty repository lock in hundreds of later decisions, so discovery and impact analysis still happen — they just look different.

## Discovery

- Check whether the directory is truly empty or the user seeded files; surface what you find.
- Check the installed toolchain for the domain (language runtimes, package managers, compilers, hardware SDKs). Recommend from what is installed, not what is fashionable.
- From the user's stated constraints, derive two or three concrete candidate approaches with explicit pros and cons. Never pick one silently — the trade-offs belong on screen.

## Lock-in analysis

For each foundational choice, state what it commits the project to and what it rules out. Adapt the axes to the domain; these are a starting point:

- **Core framework, runtime or hardware target** — what does it preclude, and what is the upgrade story?
- **Data, state or content model** — where does the canonical form live, and how does a downstream reader or non-developer use it? Migration story?
- **Packaging and deployment target** — runs anywhere, or only here?
- **Interface shape** — any boundary (API, CLI, file format, protocol) is a contract, and contracts are one-way doors.
- **Testing and verification** — what rigour does the domain demand?

Classify each decision as \`reversible\`, \`expensive-to-reverse\` or \`one-way-door\`. One-way doors get extra scrutiny and an ADR (\`marvin:adr\`).

Present it as a checklist, let the user call out anything missed, and only then propose the architecture.
`,
};

/**
 * Write the core skills as a local plugin and return the spec the SDK's
 * `plugins` option takes. Rewrites only when the content hash changes, and
 * drops skill directories this version no longer ships. Never throws: a
 * failure returns null and the turn runs without them.
 */
export function coreSkillsPluginConfig(root: string = join(getMarvinDataDir(), "core-skills")): { type: "local"; path: string } | null {
  try {
    const hash = createHash("sha256").update(JSON.stringify(CORE_SKILLS)).digest("hex").slice(0, 16);
    const stamp = join(root, ".content-hash");
    const current = existsSync(stamp) ? readFileSync(stamp, "utf-8").trim() : "";
    if (current !== hash) {
      rmSync(join(root, "skills"), { recursive: true, force: true });
      mkdirSync(join(root, ".claude-plugin"), { recursive: true });
      writeFileSync(
        join(root, ".claude-plugin", "plugin.json"),
        `${JSON.stringify({ name: CORE_SKILLS_PLUGIN, version: "1.0.0", description: "MARVIN's own on-demand procedures (ADR-0118). Generated — edit core-skills.ts." }, null, 2)}\n`,
      );
      for (const [name, text] of Object.entries(CORE_SKILLS)) {
        mkdirSync(join(root, "skills", name), { recursive: true });
        writeFileSync(join(root, "skills", name, "SKILL.md"), text);
      }
      writeFileSync(stamp, `${hash}\n`);
    }
    return { type: "local", path: root };
  } catch {
    return null;
  }
}
