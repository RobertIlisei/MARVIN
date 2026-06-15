/**
 * Project context injection for MARVIN.
 *
 * Every session is scoped to ONE project — the thing the user is building.
 * On the first message of a session we read any project-authored context
 * documents (by default: `PROJECT_STATUS.md`, `BUSINESS_OVERVIEW.md`,
 * `README.md` if present) from the project's workDir and prepend them to the
 * system prompt.
 *
 * This module is **project-agnostic**. It reads only the files that exist in
 * the user's project directory; it does not know about any specific project,
 * service, or stack.
 */


import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { graphPathForScope, summarizeGraph } from "@marvin/graphify-bridge";

import type { InfraProbe } from "./infra-probes";
import { formatProbeBlock, runProbes } from "./infra-probes";
import {
  checkWorkflowHealth,
  formatWorkflowHealthBlock,
} from "./workflow-health";
import {
  detectFingerprint,
  formatFingerprintBlock,
  formatSkillAuditBlock,
} from "./fingerprint";

export interface ProjectContextOptions {
  /** The active project's working directory. Docs are read from here. */
  workDir: string;
  /** When `true`, the context block is included. Caller sets `false` on
   *  follow-up turns so we don't re-inject the same docs each message. */
  firstMessage: boolean;
  /** Override which files are injected. Defaults to the list below. */
  files?: string[];
  /** Optional: probes to run. Empty by default — MARVIN has no opinion about
   *  which services a project depends on. */
  probes?: Array<() => Promise<InfraProbe>>;
  /**
   * Directories (relative to workDir) containing ADR-like decision records.
   * Every `.md` file under each dir is injected. Defaults to the conventional
   * ADR locations. Use `[]` to disable.
   */
  adrDirs?: string[];
  /**
   * Project memory file (relative to workDir) — MARVIN's running one-line
   * log of decisions, invariants, and gotchas accumulated across sessions.
   * MARVIN appends to this during the Ship phase; we inject it at Discovery.
   */
  memoryFile?: string;
}

const DEFAULT_FILES = ["PROJECT_STATUS.md", "BUSINESS_OVERVIEW.md", "README.md"];
const DEFAULT_ADR_DIRS = ["docs/adr", "docs/adrs", "docs/decisions"];
const DEFAULT_MEMORY_FILE = ".marvin/memory.md";

/** How much of a long memory.md to inject (recent tail). ADR-0041. */
const MEMORY_TAIL_TOKENS = 8000;
/**
 * Soft ceiling for the whole first-message context (ADR-0041). The curated
 * project docs are kept whole (golden rule 5) and ADRs are already titles-only,
 * so this is a backstop: when the assembled context still exceeds it (usually
 * because the curated docs themselves are large), we surface a note rather than
 * silently truncating the user's chosen docs.
 */
const CONTEXT_TOKEN_BUDGET = 90000;

/**
 * Read ADR TITLES only (ADR-0041). Injecting every ADR in full overflowed the
 * context window on mature projects (139 ADRs ≈ 462K tokens vs a 200K window).
 * The first-message context now lists titles; MARVIN pulls a specific ADR's
 * full text on demand (knowledge graph → Read the file). Reads just the head of
 * each file to find its `#`/`##` heading.
 */
async function readAdrTitles(
  workDir: string,
  dirs: string[],
): Promise<Array<{ rel: string; title: string }>> {
  const out: Array<{ rel: string; title: string; mtime: number }> = [];
  for (const dir of dirs) {
    const full = join(workDir, dir);
    let entries: string[];
    try {
      const st = await stat(full);
      if (!st.isDirectory()) continue;
      entries = await readdir(full);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      const path = join(full, name);
      try {
        const [content, fileStat] = await Promise.all([
          readFile(path, "utf-8"),
          stat(path),
        ]);
        out.push({
          rel: `${dir}/${name}`,
          title: extractHeading(content) ?? name.replace(/\.md$/, ""),
          mtime: fileStat.mtimeMs,
        });
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ rel, title }) => ({ rel, title }));
}

/** First markdown heading (`#`/`##`/`###`) in the file's first 40 lines. */
function extractHeading(content: string): string | null {
  const lines = content.split("\n", 40);
  for (const raw of lines) {
    const m = /^#{1,3}\s+(.+\S)\s*$/.exec(raw.trim());
    if (m) return m[1] ?? null;
  }
  return null;
}

/** Cheap token estimate — ~4 chars/token. Good enough for budgeting. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Keep the most-recent `maxTokens` worth of `s` (tail), since the newest
 * entries matter most for a running log. Returns whether it was clipped.
 */
function tailByTokens(s: string, maxTokens: number): { text: string; clipped: boolean } {
  const maxChars = maxTokens * 4;
  if (s.length <= maxChars) return { text: s, clipped: false };
  return { text: s.slice(s.length - maxChars), clipped: true };
}

/**
 * Build a markdown context block prepended to the system prompt.
 *
 * Two layers:
 *   - **Heavy context** (docs, ADRs, project memory, graph god-nodes) —
 *     injected only on the FIRST message of a session, because repeating
 *     them every turn burns tokens for no gain; Claude carries them in
 *     the running conversation.
 *   - **Workflow health** — injected on EVERY turn while gaps exist, so
 *     an ambiguous continuation prompt like "check again" still sees
 *     the audit instruction. The block disappears automatically once
 *     the gaps close (ADRs land, memory fills, graph gets built).
 *
 * Returns `""` when nothing is available.
 */
export async function buildProjectContext(
  options: ProjectContextOptions,
): Promise<string> {
  // Workflow-health runs every turn — cheap, high-signal, and self-
  // expiring. Done first so even an early-return path still includes it.
  let workflowHealthBlock = "";
  try {
    const health = checkWorkflowHealth(options.workDir);
    workflowHealthBlock = formatWorkflowHealthBlock(health);
  } catch {
    /* non-fatal */
  }

  // Skill-audit pending block (ADR-0024). Same self-expiring shape as
  // workflow-health: re-injects every turn UNTIL `<workDir>/.marvin/skills.md`
  // exists. The fingerprint itself is heavy context — first-message only —
  // but the audit-pending reminder needs to persist so an ambiguous
  // continuation prompt still triggers the recommendation rule.
  let fingerprint: ReturnType<typeof detectFingerprint> | null = null;
  let skillAuditBlock = "";
  try {
    fingerprint = detectFingerprint(options.workDir);
    skillAuditBlock = formatSkillAuditBlock(fingerprint);
  } catch {
    /* non-fatal */
  }

  // Non-first-message turns still get the persistent reminders so MARVIN
  // keeps seeing them. Skip the expensive doc/ADR/memory/graph/fingerprint
  // re-injection — those already landed on turn 1.
  if (!options.firstMessage) {
    if (!workflowHealthBlock && !skillAuditBlock) return "";
    const header =
      "# Project context (ongoing turn)\n\n" +
      "Standing reminders below. They persist every turn until the " +
      "underlying signal (workflow gaps, skill audit) is closed on " +
      "disk.\n\n---\n\n";
    const parts: string[] = [];
    if (workflowHealthBlock) parts.push(workflowHealthBlock);
    if (skillAuditBlock) parts.push(skillAuditBlock);
    return `${header}${parts.join("\n\n---\n\n")}`;
  }

  const files = options.files ?? DEFAULT_FILES;
  const adrDirs = options.adrDirs ?? DEFAULT_ADR_DIRS;
  const memoryFile = options.memoryFile ?? DEFAULT_MEMORY_FILE;

  const sections: string[] = [];
  for (const rel of files) {
    const full = join(options.workDir, rel);
    try {
      const content = (await readFile(full, "utf-8")).trim();
      if (content) sections.push(`## ${rel}\n\n${content}`);
    } catch {
      // File missing is not an error — projects opt in by creating the file.
    }
  }

  // Architecture Decision Records — binding past decisions. TITLES ONLY
  // (ADR-0041): the full text of every ADR overflowed the context window on
  // mature projects. MARVIN pulls a specific ADR on demand via the knowledge
  // graph (`scope:"knowledge"`) → Read the file.
  const adrTitles = await readAdrTitles(options.workDir, adrDirs).catch(() => []);
  if (adrTitles.length > 0) {
    const index = adrTitles.map(({ rel, title }) => `- \`${rel}\` — ${title}`).join("\n");
    sections.push(
      `## Architecture Decision Records (${adrTitles.length} — titles only)\n\n` +
        `These decisions bind current work. Only titles are listed to keep ` +
        `context lean. To use one:\n` +
        `1. Find the relevant ADR(s) — query the knowledge graph ` +
        `(\`graph_search\` / \`graph_neighbors\`, \`scope:"knowledge"\`) by topic, ` +
        `or scan this list;\n` +
        `2. **Read the specific ADR file** for its full text before relying on it.\n\n` +
        `If a proposed change contradicts an ADR, flag it explicitly and either ` +
        `refine the plan or write a new ADR superseding the old one.\n\n${index}`,
    );
  }

  // Project memory — MARVIN's running log across sessions. Bounded to its
  // recent tail (ADR-0041): a long-lived log can grow to hundreds of KB, which
  // alone can blow the window. Newest entries matter most; older ones stay in
  // the file and are indexed in the knowledge graph.
  try {
    const memPath = join(options.workDir, memoryFile);
    const memContent = (await readFile(memPath, "utf-8")).trim();
    if (memContent) {
      const { text, clipped } = tailByTokens(memContent, MEMORY_TAIL_TOKENS);
      const note = clipped
        ? `\n\n_Showing the most recent ~${MEMORY_TAIL_TOKENS / 1000}k tokens of a ` +
          `larger log. Older entries are in \`${memoryFile}\` and indexed in the ` +
          `knowledge graph (\`scope:"knowledge"\`) — query or Read the file for them._\n`
        : "";
      sections.push(
        `## Project memory (\`${memoryFile}\`)${clipped ? " — recent tail" : ""}\n\n` +
          `Curated index of DURABLE FACTS (invariants, gotchas, constraints, ` +
          `external facts). Each links to \`.marvin/memory/<slug>.md\` — use the ` +
          `\`recall\` tool (or Read the file) for detail. Write ONLY via the ` +
          `\`remember\` tool; never echo activity/decisions/status here (ADR-0042).` +
          `${note}\n\n${text}`,
      );
    }
  } catch {
    // No memory file yet — fine; MARVIN will create it at first Ship.
  }

  let probeBlock = "";
  if (options.probes && options.probes.length > 0) {
    try {
      const results = await runProbes(options.probes);
      probeBlock = formatProbeBlock(results);
    } catch {
      /* non-fatal */
    }
  }

  // Knowledge-graph header. When the project has a graphify graph, orient
  // MARVIN to the structural spine so it can decide whether to query the
  // graph (via mcp tools) vs. read files. The block is compact on purpose —
  // detailed queries happen through the graph_* tools at runtime.
  let graphBlock = "";
  try {
    // First-message orientation reads the CODE graph only — knowledge graph
    // is opt-in per ADR-0028 and not part of the standing prompt.
    const summary = summarizeGraph(graphPathForScope(options.workDir, "code"));
    if (summary.ok) {
      const godNodeLines = summary.godNodes
        .slice(0, 8)
        .map((g) => `- **${g.label}**  (id: \`${g.id}\`, ${g.degree} edges)`)
        .join("\n");
      const communityLines = summary.communities
        .slice(0, 6)
        .map(
          (c) =>
            `- [${c.id}] ${c.size} nodes — ${c.sampleLabels.slice(0, 4).join(" · ")}`,
        )
        .join("\n");
      graphBlock =
        "## Knowledge graph (graphify)\n\n" +
        `A graphify graph lives at \`graphify-out/graph.json\` ` +
        `(${summary.stats.nodes} nodes · ${summary.stats.edges} edges · ` +
        `${summary.stats.communities} communities, updated ${summary.updatedAt ?? "unknown"}).\n\n` +
        `**Use the graph BEFORE reading files** for any architectural or ` +
        `"how does X work" question. It's ~36× cheaper than a file sweep and ` +
        `points you at the right file + line directly. Available MCP tools:\n\n` +
        `- \`graph_summary\` — full overview\n` +
        `- \`graph_search\` — find nodes by label (start here)\n` +
        `- \`graph_neighbors\` — 1-hop blast radius for a node\n` +
        `- \`graph_path\` — shortest path between two concepts\n\n` +
        `### God nodes (most-connected abstractions — the structural spine)\n\n${godNodeLines}\n\n` +
        `### Top communities\n\n${communityLines}`;
    }
  } catch {
    /* graphify is optional — absence is normal */
  }

  // `workflowHealthBlock` was computed at the top of the function so that
  // non-first-message turns also get it. Re-used here.

  if (
    sections.length === 0 &&
    !probeBlock &&
    !graphBlock &&
    !workflowHealthBlock
  ) {
    return "";
  }

  const header =
    "# Project context\n\n" +
    "The documents below are authored in the user's project repository. " +
    "Use them to ground your work. If you notice drift between what they " +
    "describe and what the code actually contains, surface it before acting.\n\n---\n\n";

  // Fingerprint block — heavy context, first-message only. Only emits
  // when the project has substance and at least one tag matched.
  const fingerprintBlock = fingerprint ? formatFingerprintBlock(fingerprint) : "";

  const parts: string[] = [];
  if (workflowHealthBlock) parts.push(workflowHealthBlock);
  if (skillAuditBlock) parts.push(skillAuditBlock);
  if (fingerprintBlock) parts.push(fingerprintBlock);
  if (graphBlock) parts.push(graphBlock);
  if (sections.length > 0) parts.push(sections.join("\n\n---\n\n"));
  const body = parts.join("\n\n---\n\n");
  const probe = probeBlock ? `\n\n---\n\n${probeBlock}` : "";
  const assembled = `${header}${body}${probe}`;

  // Backstop (ADR-0041): if the context is still very large, it's the curated
  // docs (kept whole per golden rule 5) — don't truncate them silently; tell
  // MARVIN so it can lean on the graph + targeted reads instead of assuming
  // everything's in context.
  if (approxTokens(assembled) > CONTEXT_TOKEN_BUDGET) {
    const note =
      `> **Note:** this project's context is large ` +
      `(~${Math.round(approxTokens(assembled) / 1000)}k tokens). ADRs are listed ` +
      `as titles only and memory is the recent tail — pull detail on demand via ` +
      `the knowledge graph (\`scope:"knowledge"\`) and targeted file reads rather ` +
      `than assuming the full corpus is in context.\n\n`;
    return `${header}${note}${body}${probe}`;
  }
  return assembled;
}

export type { InfraProbe } from "./infra-probes";
export { formatProbeBlock, probeDockerContainer, probeHttp, runProbes } from "./infra-probes";
export type { WorkflowHealth } from "./workflow-health";
export { checkWorkflowHealth, formatWorkflowHealthBlock } from "./workflow-health";
export type { ProjectFingerprint } from "./fingerprint";
export {
  detectFingerprint,
  formatFingerprintBlock,
  formatSkillAuditBlock,
} from "./fingerprint";
