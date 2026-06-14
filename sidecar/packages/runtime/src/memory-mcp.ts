/**
 * marvin-memory — in-process MCP server for the curated durable-facts layer
 * (ADR-0042). The sanctioned, ENFORCED write path for `.marvin/memory.md`.
 *
 * Why a tool and not "Edit memory.md": prose guidance ("append one line")
 * was ignored — the model mirrored its verbose changelog/ADR entry into memory,
 * growing it to 419 KB / ~99% redundant. `remember` enforces at the boundary:
 * one fact → one small file under `<workDir>/.marvin/memory/<slug>.md` + a
 * one-line index entry in `memory.md`; it caps the hook, rejects activity/status
 * content, and supersedes by name instead of blind-appending.
 *
 * Scoped to the active project's workDir (like marvin-graph) — never MARVIN's
 * own repo.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const INDEX_HEADER = "# Project Memory Index";
const MAX_HOOK_CHARS = 200;
const MAX_BODY_CHARS = 2000;

/**
 * Content that belongs in ADRs / git / the changelog — NOT in memory. If a
 * `remember` payload smells like an activity/Ship trail or ephemeral status,
 * reject it with guidance rather than letting the bloat back in.
 */
const BANNED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bnot committed\b|\bnot pushed\b|\bcommitted\/pushed\b/i, why: "commit state lives in git" },
  { re: /\bvitest\b|\btsc clean\b|\beslint\b|\b\d+\/\d+ (tests|passing)\b/i, why: "test/verification status is ephemeral" },
  { re: /\blanded\b.*\bADR-\d+|\bas-built\b|\brevision history\b/i, why: "implementation/ADR detail belongs in the ADR + git" },
];

function slugify(name: string): string {
  const mapped = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = mapped.replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return trimmed || "fact";
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const TYPE_ENUM = ["user", "feedback", "project", "reference"] as const;

/**
 * Rebuild memory.md from the header + a fresh index of every fact file. Keeps
 * the index canonical (no drift between files and index) and inherently
 * deduped — one line per file.
 */
async function rewriteIndex(workDir: string): Promise<number> {
  const memDir = join(workDir, ".marvin", "memory");
  let files: string[] = [];
  try {
    files = (await readdir(memDir)).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }
  const entries: Array<{ name: string; hook: string; slug: string }> = [];
  for (const f of files.sort()) {
    try {
      const content = await readFile(join(memDir, f), "utf-8");
      const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? f.replace(/\.md$/, "");
      const hook = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
      entries.push({ name, hook, slug: f.replace(/\.md$/, "") });
    } catch {
      /* skip unreadable */
    }
  }
  const lines = entries.map(
    (e) => `- [${e.name}](memory/${e.slug}.md)${e.hook ? ` — ${e.hook}` : ""}`,
  );
  const body =
    `${INDEX_HEADER}\n\n` +
    `One line per durable fact (invariants, gotchas, constraints, external ` +
    `facts). Details live in \`.marvin/memory/<slug>.md\`. Per-turn activity, ` +
    `decisions, and verification status do NOT belong here — they live in ADRs, ` +
    `git, and the changelog (ADR-0042).\n\n` +
    (lines.length ? lines.join("\n") : "_No facts recorded yet._") +
    "\n";
  await writeFile(join(workDir, ".marvin", "memory.md"), body, "utf-8");
  return entries.length;
}

export function createMemoryMcpServer(workDir: string) {
  const rememberTool = tool(
    "remember",
    "Record a DURABLE FACT to project memory — an invariant, gotcha, hard " +
      "constraint, or external fact the next session can't re-derive from ADRs, " +
      "git, or the changelog. Writes one small file under .marvin/memory/ and a " +
      "one-line index entry. Use the SAME `name` to update/supersede an existing " +
      "fact. Do NOT use this for what you implemented this turn, decisions (→ " +
      "ADR), or test/commit status (→ git) — those are rejected.",
    {
      name: z.string().min(1).describe("Short stable title; the dedup key. Reusing it updates the fact in place."),
      hook: z.string().min(1).describe(`One-line summary shown in the index (≤${MAX_HOOK_CHARS} chars).`),
      body: z.string().optional().describe(`Optional detail (≤${MAX_BODY_CHARS} chars). Keep it to the fact — not a Ship trail.`),
      type: z.enum(TYPE_ENUM).optional().describe("user | feedback | project | reference. Default project."),
    },
    async ({ name, hook, body, type }) => {
      const hookOneLine = hook.replace(/\s+/g, " ").trim();
      if (hookOneLine.length > MAX_HOOK_CHARS) {
        return errorResult(
          `Hook is ${hookOneLine.length} chars (max ${MAX_HOOK_CHARS}). memory is a ` +
            `one-line-per-fact index — tighten it to the essential invariant/gotcha.`,
        );
      }
      const bodyText = (body ?? "").trim();
      if (bodyText.length > MAX_BODY_CHARS) {
        return errorResult(
          `Body is ${bodyText.length} chars (max ${MAX_BODY_CHARS}). If it needs more, ` +
            `it's probably a decision (→ ADR) or an implementation trail (→ git/changelog), ` +
            `not a memory fact.`,
        );
      }
      const haystack = `${hookOneLine}\n${bodyText}`;
      for (const { re, why } of BANNED_PATTERNS) {
        if (re.test(haystack)) {
          return errorResult(
            `Rejected — this reads like activity/status, not a durable fact (${why}). ` +
              `memory.md holds only what's NOT re-derivable from ADRs/git/changelog ` +
              `(ADR-0042). Record decisions in an ADR and status in git/changelog.`,
          );
        }
      }
      const slug = slugify(name);
      const memDir = join(workDir, ".marvin", "memory");
      try {
        await mkdir(memDir, { recursive: true });
        const fm =
          `---\n` +
          `name: ${name.replace(/\n/g, " ").trim()}\n` +
          `description: ${hookOneLine}\n` +
          `type: ${type ?? "project"}\n` +
          `---\n\n${bodyText || hookOneLine}\n`;
        const existed = existsSync(join(memDir, `${slug}.md`));
        await writeFile(join(memDir, `${slug}.md`), fm, "utf-8");
        const count = await rewriteIndex(workDir);
        return textResult(
          `${existed ? "Updated" : "Saved"} fact \`${slug}\` (${type ?? "project"}). ` +
            `memory index now has ${count} fact${count === 1 ? "" : "s"}.`,
        );
      } catch (err) {
        return errorResult(`Failed to write memory fact: ${(err as Error).message}`);
      }
    },
  );

  const recallTool = tool(
    "recall",
    "Search project memory (the durable facts under .marvin/memory/) for a " +
      "topic. Use it on Intake / before assuming an invariant. Returns matching " +
      "facts with their hooks and file paths; Read the file for full detail.",
    {
      query: z.string().min(1).describe("Free-text — matched against fact names, hooks, and bodies."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results. Default 10."),
    },
    async ({ query, limit }) => {
      const memDir = join(workDir, ".marvin", "memory");
      let files: string[];
      try {
        files = (await readdir(memDir)).filter((f) => f.endsWith(".md"));
      } catch {
        return textResult("No project memory yet (.marvin/memory/ is empty).");
      }
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits: Array<{ slug: string; name: string; hook: string; score: number }> = [];
      for (const f of files) {
        try {
          const content = await readFile(join(memDir, f), "utf-8");
          const lc = content.toLowerCase();
          const score = terms.reduce((n, t) => n + (lc.includes(t) ? 1 : 0), 0);
          if (score > 0) {
            const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? f.replace(/\.md$/, "");
            const hook = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
            hits.push({ slug: f.replace(/\.md$/, ""), name, hook, score });
          }
        } catch {
          /* skip */
        }
      }
      if (hits.length === 0) return textResult(`No memory facts match "${query}".`);
      hits.sort((a, b) => b.score - a.score);
      const lines = hits
        .slice(0, limit ?? 10)
        .map((h) => `- ${h.name} — ${h.hook}  (.marvin/memory/${h.slug}.md)`);
      return textResult(`Memory facts matching "${query}":\n${lines.join("\n")}`);
    },
  );

  return createSdkMcpServer({
    name: "marvin-memory",
    version: "1.0.0",
    tools: [rememberTool, recallTool],
  });
}
