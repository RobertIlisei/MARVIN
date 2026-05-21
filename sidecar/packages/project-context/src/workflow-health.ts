/**
 * Workflow-health probe for an in-flight project.
 *
 * Answers: does the project have MARVIN's workflow deliverables
 * (ADRs, running project memory, an up-to-date knowledge graph)?
 * Computed on the first message of every session and injected into the
 * system prompt so MARVIN can surface gaps and propose a retroactive
 * catch-up pass — without the user having to ask.
 *
 * **Project-agnostic by design.** This module knows NOTHING about what
 * kind of project the user is building. It does not detect frameworks,
 * languages, tooling, services, or stacks — enumerating "material
 * decisions already made" is MARVIN's job at runtime by reading the
 * repo itself. We only check the four workflow-deliverable gaps; those
 * gaps apply identically regardless of domain, language, or stack.
 *
 * All checks are local FS stats; no subprocess spawns.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowHealth {
  /** Absolute workDir the probe was run against. */
  workDir: string;
  /** True when the project has more than trivial content — worth auditing. */
  hasSubstance: boolean;
  /** Count of `docs/adr/*.md` files (excluding READMEs). */
  adrCount: number;
  /** Whether `.marvin/memory.md` exists and has non-empty content. */
  memoryPresent: boolean;
  /** Whether `graphify-out/graph.json` exists. */
  graphPresent: boolean;
  /**
   * Days between the newest non-ignored file mtime and the graph mtime.
   * `null` when the graph is missing or not meaningfully stale.
   */
  graphStaleDays: number | null;
  /**
   * Whether `<workDir>/.graphifyignore` exists. When false on a substantial
   * project, graphify will pull in node_modules-sized cache trees / vendored
   * code / build artefacts — see ADR-context in the project's CLAUDE.md.
   * MARVIN's personality.ts carries the protocol for scaffolding one.
   */
  graphifyIgnorePresent: boolean;
  /** Human-readable list of gaps, empty array when healthy. */
  gaps: string[];
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "target",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "coverage",
  ".cache",
  "graphify-out",
]);

/**
 * Walk the repo bounded by `maxEntries`, returning (newest-mtime, file-count)
 * across every non-ignored file regardless of extension. Completely
 * language- and stack-agnostic — a `.f90`, a `.ipynb`, a `.Dockerfile`, and
 * a `.ts` all count.
 */
function walkRepo(root: string, maxEntries = 4000): {
  newestMtime: number;
  fileCount: number;
} {
  let newestMtime = 0;
  let fileCount = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && fileCount < maxEntries) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (fileCount >= maxEntries) break;
      if (SKIP_DIRS.has(name)) continue;
      // Hide most dotfiles from the walk but keep .github/ so CI-ish repos
      // still look substantive if only a workflow file exists.
      if (name.startsWith(".") && name !== ".github") continue;
      const full = `${dir}/${name}`;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        fileCount += 1;
        if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
      }
    }
  }
  return { newestMtime, fileCount };
}

function countAdrs(workDir: string): number {
  const dirs = ["docs/adr", "docs/adrs", "docs/decisions"];
  let total = 0;
  for (const rel of dirs) {
    const full = join(workDir, rel);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      for (const name of readdirSync(full)) {
        if (name.endsWith(".md") && !name.toUpperCase().startsWith("README")) {
          total += 1;
        }
      }
    } catch {
      /* skip */
    }
  }
  return total;
}

function memoryHasContent(workDir: string): boolean {
  try {
    const memPath = join(workDir, ".marvin", "memory.md");
    const st = statSync(memPath);
    if (!st.isFile() || st.size === 0) return false;
    // Size alone is a good enough signal; no need to read the file here.
    const content = readFileSync(memPath, "utf-8").trim();
    return content.length > 0;
  } catch {
    return false;
  }
}

export function checkWorkflowHealth(workDir: string): WorkflowHealth {
  const gaps: string[] = [];

  // Substance: at least 4 non-ignored files at any depth. A truly empty
  // repo, a fresh-init `.git` + `README`, or a single-file sketch will
  // not trip the audit.
  const { newestMtime, fileCount } = walkRepo(workDir);
  const hasSubstance = fileCount >= 4;

  const adrCount = countAdrs(workDir);
  const memoryPresent = memoryHasContent(workDir);

  // Graph presence + staleness.
  let graphPresent = false;
  let graphStaleDays: number | null = null;
  try {
    const graphPath = join(workDir, "graphify-out", "graph.json");
    const st = statSync(graphPath);
    if (st.isFile() && st.size > 0) {
      graphPresent = true;
      if (newestMtime > 0) {
        const deltaMs = newestMtime - st.mtimeMs;
        if (deltaMs > 24 * 60 * 60 * 1000) {
          graphStaleDays = Math.round(deltaMs / (24 * 60 * 60 * 1000));
        }
      }
    }
  } catch {
    /* not present */
  }

  // Cheap stat — no Read needed since we only care about presence + non-zero size.
  let graphifyIgnorePresent = false;
  try {
    const st = statSync(join(workDir, ".graphifyignore"));
    graphifyIgnorePresent = st.isFile() && st.size > 0;
  } catch {
    /* absent */
  }

  if (hasSubstance && adrCount === 0) {
    gaps.push("no ADRs — `docs/adr/` is empty or missing");
  }
  if (hasSubstance && !memoryPresent) {
    gaps.push("no project memory — `.marvin/memory.md` is absent");
  }
  if (hasSubstance && !graphPresent) {
    gaps.push(
      "no graphify graph — run `/graphify .` so future impact analysis has one",
    );
  }
  if (graphStaleDays != null && graphStaleDays >= 1) {
    gaps.push(
      `graph is ${graphStaleDays}d stale vs newest code — run \`/graphify . --update\``,
    );
  }
  // The .graphifyignore gap is independent of whether the graph already
  // exists. If it exists without an ignore, the graph is probably mapping
  // cache trees / vendored code; if it doesn't exist yet, we want the
  // ignore in place BEFORE the first build so day-one is clean.
  // Either way, propose scaffolding one via the personality.ts protocol.
  if (hasSubstance && !graphifyIgnorePresent) {
    gaps.push(
      graphPresent
        ? "no `.graphifyignore` — graph likely maps caches / build dirs / vendored code; scaffold one and rebuild"
        : "no `.graphifyignore` — write one BEFORE `/graphify .` so day-one is clean (see graphify-protocol in your instructions)",
    );
  }

  return {
    workDir,
    hasSubstance,
    adrCount,
    memoryPresent,
    graphPresent,
    graphStaleDays,
    graphifyIgnorePresent,
    gaps,
  };
}

/** Markdown block suitable for concatenation into buildProjectContext. */
export function formatWorkflowHealthBlock(h: WorkflowHealth): string {
  if (!h.hasSubstance || h.gaps.length === 0) return "";
  const gapLines = h.gaps.map((g) => `- ${g}`).join("\n");

  return [
    "## Workflow health",
    "",
    "This project has real content but is missing workflow deliverables:",
    "",
    gapLines,
    "",
    "This block is a standing reminder — it re-injects every turn until " +
      "the gaps close on disk. It is **not** a command to re-audit on " +
      "every turn. Consult the \"Workflow audit — catching up an in-flight " +
      "project\" section of your instructions for the Mode-A / Mode-B / " +
      "Mode-C logic:",
    "",
    "- **Mode A** (first audit of this conversation): propose ADRs + " +
      "graphify + memory entries, STOP and wait.",
    "- **Mode B** (you already proposed earlier in this same conversation " +
      "AND the user is continuing, approving, or asking for next steps): " +
      "EXECUTE — write the ADR files, create `.marvin/memory.md`, run " +
      "`/graphify .`. Do NOT re-audit.",
    "- **Mode C** (user explicitly defers): label `**[Phase · Fast-path]**` " +
      "and move on to their ask.",
    "",
    "The gaps above close on disk. When they do, this block disappears.",
  ].join("\n");
}
