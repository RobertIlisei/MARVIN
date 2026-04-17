/**
 * Project context injection for MARVIN.
 *
 * Each conversation is scoped to ONE project — the thing the user is
 * building. At the start of every new session (first message) we inject:
 *
 *   1. `PROJECT_STATUS.md` content — what's shipped, what's in flight.
 *   2. `BUSINESS_OVERVIEW.md` content — vision, tiers, infra stack.
 *   3. Live infra probe results (UP / DOWN for each service the spec lists).
 *
 * Ported from `~/command_center/J.A.R.V.I.S/src/lib/project-context.ts`.
 * MARVIN changes:
 *   - NO `contextAwareAgents` list — there's only one assistant; everyone
 *     gets the context.
 *   - NO `maxContextChars` truncation. Today's-Marvin-context-window is
 *     measured in hundreds of thousands of tokens. We inject the whole spec.
 *   - Replaces the `configAware` config machinery with a simple
 *     `options.firstMessage` flag the caller passes.
 */

import { readFile } from "fs/promises";
import { join } from "path";

import { buildInfraProbeBlock } from "./infra-probes";

export interface ProjectContextOptions {
  /** The active project's working directory. Docs are read from here. */
  workDir: string;
  /** When `true`, the probe block is included. Set `false` on follow-up turns
   *  in the same session so we don't re-inject the full spec each turn. */
  firstMessage: boolean;
  /** Override which files are injected. Defaults to the canonical trio. */
  files?: string[];
}

const DEFAULT_FILES = ["PROJECT_STATUS.md", "BUSINESS_OVERVIEW.md"];

/**
 * Build a markdown context block to prepend to the user's first message in a
 * session. Returns `""` when nothing is available.
 */
export async function buildProjectContext(options: ProjectContextOptions): Promise<string> {
  if (!options.firstMessage) return "";
  const files = options.files ?? DEFAULT_FILES;

  const sections: string[] = [];
  for (const rel of files) {
    const full = join(options.workDir, rel);
    try {
      const content = (await readFile(full, "utf-8")).trim();
      if (content) {
        sections.push(`## ${rel}\n\n${content}`);
      }
    } catch {
      // File missing — not an error.
    }
  }

  // Run probes in parallel with file reads in practice (fire-and-forget
  // here since we're already inside an async function). `buildInfraProbeBlock`
  // swallows all errors and returns "" when probes can't run.
  let probeBlock = "";
  try {
    probeBlock = await buildInfraProbeBlock();
  } catch {
    /* non-fatal */
  }

  if (sections.length === 0 && !probeBlock) return "";

  const header =
    "# Project context\n\n" +
    "Use the following documents to ground your work. When you observe the " +
    "project state drifting from the spec (e.g. a listed service is DOWN in " +
    "reality), surface it to the user before acting.\n\n---\n\n";

  const body = sections.join("\n\n---\n\n");
  const probe = probeBlock ? `\n\n---\n\n${probeBlock}` : "";
  return `${header}${body}${probe}`;
}
