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

import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";

import type { InfraProbe } from "./infra-probes";
import { formatProbeBlock, runProbes } from "./infra-probes";

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

async function readAdrs(
  workDir: string,
  dirs: string[],
): Promise<Array<{ rel: string; content: string }>> {
  const out: Array<{ rel: string; content: string; mtime: number }> = [];
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
        if (content.trim()) {
          out.push({
            rel: `${dir}/${name}`,
            content: content.trim(),
            mtime: fileStat.mtimeMs,
          });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  // Newest ADRs last — readers expect chronological order.
  return out
    .sort((a, b) => a.mtime - b.mtime)
    .map(({ rel, content }) => ({ rel, content }));
}

/**
 * Build a markdown context block to prepend to the user's first message in
 * a session. Returns `""` when nothing is available.
 */
export async function buildProjectContext(
  options: ProjectContextOptions,
): Promise<string> {
  if (!options.firstMessage) return "";
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

  // Architecture Decision Records — binding past decisions that must still
  // be honored. Injected chronologically so context reads like a log.
  const adrs = await readAdrs(options.workDir, adrDirs).catch(() => []);
  if (adrs.length > 0) {
    const adrBlocks = adrs
      .map(({ rel, content }) => `### ${rel}\n\n${content}`)
      .join("\n\n---\n\n");
    sections.push(
      `## Architecture Decision Records\n\n` +
        `These decisions bind current work. If a proposed change contradicts ` +
        `an ADR, flag it explicitly and either refine the plan or write a new ` +
        `ADR superseding the old one.\n\n---\n\n${adrBlocks}`,
    );
  }

  // Project memory — MARVIN's running log across sessions.
  try {
    const memPath = join(options.workDir, memoryFile);
    const memContent = (await readFile(memPath, "utf-8")).trim();
    if (memContent) {
      sections.push(
        `## Project memory (\`${memoryFile}\`)\n\n` +
          `Running log of decisions, invariants, and gotchas accumulated across ` +
          `sessions. Append to it on Ship; read it on Intake.\n\n${memContent}`,
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

  if (sections.length === 0 && !probeBlock) return "";

  const header =
    "# Project context\n\n" +
    "The documents below are authored in the user's project repository. " +
    "Use them to ground your work. If you notice drift between what they " +
    "describe and what the code actually contains, surface it before acting.\n\n---\n\n";

  const body = sections.join("\n\n---\n\n");
  const probe = probeBlock ? `\n\n---\n\n${probeBlock}` : "";
  return `${header}${body}${probe}`;
}

export { probeHttp, probeDockerContainer, runProbes, formatProbeBlock } from "./infra-probes";
export type { InfraProbe } from "./infra-probes";
