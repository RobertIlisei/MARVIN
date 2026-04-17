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

import { readFile } from "fs/promises";
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
}

const DEFAULT_FILES = ["PROJECT_STATUS.md", "BUSINESS_OVERVIEW.md", "README.md"];

/**
 * Build a markdown context block to prepend to the user's first message in
 * a session. Returns `""` when nothing is available.
 */
export async function buildProjectContext(
  options: ProjectContextOptions,
): Promise<string> {
  if (!options.firstMessage) return "";
  const files = options.files ?? DEFAULT_FILES;

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
