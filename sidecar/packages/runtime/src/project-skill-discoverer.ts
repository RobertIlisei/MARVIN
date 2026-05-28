/**
 * Project-local skill discoverer (development branch).
 *
 * Calls Claude once with a project's fingerprint + structure + memory +
 * recent commits, asks for 2-4 project-local skills that would be most
 * useful for THIS project, returns parsed + cached suggestions.
 *
 * On-demand only — fires when the user clicks "Discover skills" in the
 * Skills pane. NOT auto-triggered on session start. Real LLM cost; the
 * user opts in per call.
 *
 * Cache lives at <workDir>/.marvin/discovered-skills.json. Re-running
 * overwrites the cache. The cache also feeds the Skills pane so the
 * user can review suggestions across sessions without paying for a
 * fresh discovery each time.
 *
 * Skill scaffolding (writing the SKILL.md from a discovered suggestion)
 * is a separate concern — see `/api/skills/scaffold`. The discoverer
 * only proposes; the user decides which to build.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { detectFingerprint } from "@marvin/project-context";

import { latestForTier } from "./models";

const pExecFile = promisify(execFile);

export interface DiscoveredSkill {
  name: string;
  description: string;
  rationale: string;
  suggestedBody: string;
}

export interface DiscoveredSkillsPayload {
  discoveredAt: string;
  workDir: string;
  /** Marker so the Skills pane can show "stale" when the project's
   *  fingerprint shifts substantially. Joined tag string for now —
   *  cheap and good enough. */
  fingerprintMarker: string;
  suggestions: DiscoveredSkill[];
  /** Anthropic-API usage in cents (best-effort). null on error. */
  costCents: number | null;
}

const CACHE_FILE = (workDir: string) =>
  join(workDir, ".marvin", "discovered-skills.json");

/** Read the cache if present. Returns null on miss or parse error. */
export function readCachedDiscovery(workDir: string): DiscoveredSkillsPayload | null {
  const path = CACHE_FILE(workDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DiscoveredSkillsPayload;
  } catch {
    return null;
  }
}

async function recentCommits(workDir: string, count = 20): Promise<string[]> {
  try {
    const { stdout } = await pExecFile(
      "git",
      ["-C", workDir, "log", `-${count}`, "--pretty=format:%s"],
      { timeout: 5000 },
    );
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function topLevelStructure(workDir: string): string[] {
  const SKIP = new Set([
    ".git",
    "node_modules",
    ".next",
    ".turbo",
    "dist",
    "build",
    "target",
    "graphify-out",
    "vendor",
    ".cache",
    ".swiftpm",
    ".build",
    "DerivedData",
  ]);
  try {
    return readdirSync(workDir)
      .filter((n) => !SKIP.has(n) && !n.startsWith("."))
      .sort()
      .slice(0, 60);
  } catch {
    return [];
  }
}

function readMemory(workDir: string): string {
  const path = join(workDir, ".marvin", "memory.md");
  if (!existsSync(path)) return "";
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > 64 * 1024) return "";
    return readFileSync(path, "utf-8").slice(0, 32 * 1024);
  } catch {
    return "";
  }
}

function buildPrompt(args: {
  workDir: string;
  fingerprintTags: string[];
  structure: string[];
  memory: string;
  commits: string[];
}): string {
  const { workDir, fingerprintTags, structure, memory, commits } = args;
  return `You are a skill-design subagent for MARVIN, a pair-programming AI assistant.

A "skill" in MARVIN is a procedure file at \`<workDir>/.marvin/skills/<name>/SKILL.md\` that MARVIN consults when its trigger fires. Skills capture project-specific procedures the user wants enforced — checklists, audit steps, code-shape rules, build sequences — that a generic LLM would otherwise approximate inconsistently.

**Your task:** propose 2–4 project-local skills that would be most useful for THIS project. Skills that don't already exist in the catalog (test-driven-development, systematic-debugging, pr-review, security-audit, frontend-design, webapp-testing, mcp-builder, docx, pdf, pptx, xlsx, internal-comms, skill-creator, graphify). Skills that are SPECIFIC to this project's stack, domain, or recurring patterns — not generic.

**Project context (workDir: \`${workDir}\`):**

Fingerprint tags:
${fingerprintTags.length > 0 ? fingerprintTags.map((t) => "  - " + t).join("\n") : "  (none detected)"}

Top-level structure:
${structure.length > 0 ? structure.map((s) => "  - " + s).join("\n") : "  (empty)"}

${memory ? "Project memory (`.marvin/memory.md`):\n```\n" + memory + "\n```\n" : "(no .marvin/memory.md yet)"}

Recent commit messages (last ${commits.length}):
${commits.length > 0 ? commits.map((c) => "  - " + c).join("\n") : "  (no commits)"}

**Output format** — return ONLY valid XML, no prose around it:

\`\`\`xml
<suggestions>
  <suggestion>
    <name>kebab-case-skill-name</name>
    <description>One-line description shown in the Skills pane. Imperative, specific.</description>
    <rationale>Why THIS project (1-2 sentences). Reference specific tags / dirs / commit patterns that motivated the suggestion.</rationale>
    <suggestedBody>
Full SKILL.md body (without frontmatter — MARVIN adds that). Markdown.
Include: when to invoke, MUST / MUST-NOT triggers, the actual procedure
steps, and what to check at completion. Keep under 60 lines.
    </suggestedBody>
  </suggestion>
  <!-- 1-3 more suggestion blocks -->
</suggestions>
\`\`\`

**Rules:**
1. **No generic skills** — if a suggestion would apply to any TypeScript project, it's wrong. Tie every suggestion to a specific signal from the context above.
2. **No duplicates** of existing catalog skills.
3. **Honest rationales** — if the context doesn't motivate 4 suggestions, return 2 or 3.
4. **Procedure-focused** — each skill body should be a checklist or a sequence, not vague advice.
5. **Names are kebab-case**, scoped to the project domain (e.g. \`agri-saas-tenant-isolation-check\`, not \`auth-check\`).
`;
}

function parseSuggestions(text: string): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  const blockRe = /<suggestion>([\s\S]*?)<\/suggestion>/g;
  const fieldRe = (tag: string) =>
    new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const body = m[1] ?? "";
    const name = body.match(fieldRe("name"))?.[1]?.trim();
    const description = body.match(fieldRe("description"))?.[1]?.trim();
    const rationale = body.match(fieldRe("rationale"))?.[1]?.trim();
    const suggestedBody = body.match(fieldRe("suggestedBody"))?.[1]?.trim();
    if (!name || !description || !rationale || !suggestedBody) continue;
    const cleanName = name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    if (!cleanName) continue;
    out.push({
      name: cleanName,
      description: description.slice(0, 300),
      rationale: rationale.slice(0, 600),
      suggestedBody: suggestedBody.slice(0, 12000),
    });
  }
  return out.slice(0, 4);
}

/**
 * Run the discovery for `workDir`. Side effect: caches the result at
 * `<workDir>/.marvin/discovered-skills.json`. Returns the payload.
 */
export async function discoverProjectSkills(
  workDir: string,
): Promise<DiscoveredSkillsPayload> {
  const fp = detectFingerprint(workDir);
  const structure = topLevelStructure(workDir);
  const memory = readMemory(workDir);
  const commits = await recentCommits(workDir, 20);
  const prompt = buildPrompt({
    workDir,
    fingerprintTags: fp.tags,
    structure,
    memory,
    commits,
  });

  // Newest live Sonnet — tier-resolved (ADR-0029) so a new Sonnet ships
  // into this call automatically. Falls back to the static list's newest
  // Sonnet when discovery is unavailable.
  const discoveryModel =
    (await latestForTier("sonnet")) ?? "claude-sonnet-4-6";

  // One-shot Agent SDK call. No tools, no MCP, no permission machinery
  // — pure prompt-in / text-out. The SDK still routes through the same
  // credential discovery as a normal turn (host-credentials / OAuth /
  // API key), so no separate auth surface to maintain.
  let text = "";
  let costCents: number | null = null;
  const abort = new AbortController();
  // 120s hard cap. Next.js API routes are short-lived; without this the
  // request would hang indefinitely if the SDK's spawned Claude CLI got
  // stuck waiting on something.
  const timeoutId = setTimeout(() => abort.abort(), 120_000);
  try {
    for await (const evt of query({
      prompt,
      options: {
        // Sonnet is enough for a structured one-shot — opus would be
        // overkill at ~10× the price.
        model: discoveryModel,
        maxTurns: 1,
        allowedTools: [],
        mcpServers: {},
        permissionMode: "bypassPermissions",
        abortController: abort,
        cwd: workDir,
      },
    })) {
      const m = evt as SDKMessage & Record<string, unknown>;
      if (
        m.type === "assistant" &&
        Array.isArray((m as { message?: { content?: unknown[] } }).message?.content)
      ) {
        const content = (m as { message: { content: Array<{ type: string; text?: string }> } })
          .message.content;
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            text += block.text;
          }
        }
      }
      if (m.type === "result") {
        const usage = (m as { usage?: { total_cost_usd?: number } }).usage;
        if (usage?.total_cost_usd != null) {
          costCents = Math.round(usage.total_cost_usd * 100);
        }
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  const suggestions = parseSuggestions(text);
  const payload: DiscoveredSkillsPayload = {
    discoveredAt: new Date().toISOString(),
    workDir,
    fingerprintMarker: fp.tags.join("|"),
    suggestions,
    costCents,
  };
  await mkdir(join(workDir, ".marvin"), { recursive: true });
  await writeFile(CACHE_FILE(workDir), JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}
