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
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * `practice` is the class added by ADR-0101: *how to work in this project* —
 * "we tried X, it was wrong, do Y instead".
 *
 * The four that came before it do not cover it. `feedback` is guidance the
 * USER gave; a practice lesson is one the session earned. `project` is a fact
 * about the codebase. Neither holds the thing a session actually learns about
 * its own method, which is why one had to be hand-written into CLAUDE.md when
 * a day's work produced four of them.
 *
 * It reuses this store deliberately. ADR-0101 rejected a `.marvin/practice/`
 * directory for the reason ADR-0100 rejected `.marvin/conditions/`: a new
 * store must earn its own lifetime, and this content's lifetime is the
 * project's, exactly like a fact's.
 */
const TYPE_ENUM = ["user", "feedback", "project", "reference", "practice"] as const;

/**
 * A practice lesson must cite what happened.
 *
 * The whole risk of a learn-loop is that it converges on plausible-sounding
 * advice — this project's memory reached 419 KB and ~99 % redundancy the last
 * time a store accepted whatever it was handed (ADR-0042). A lesson with no
 * evidence behind it is exactly that failure in miniature, so the boundary
 * demands the evidence rather than trusting the prompt to ask for it.
 */
const MIN_PRACTICE_BODY_CHARS = 80;

/**
 * Rebuild memory.md from the header + a fresh index of every fact file. Keeps
 * the index canonical (no drift between files and index) and inherently
 * deduped — one line per file.
 */
export async function rewriteMemoryIndex(workDir: string): Promise<number> {
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
  // Wikilink rather than a markdown link (ADR-0065): Obsidian resolves
  // `[[memory/<slug>]]` to the note and draws the edge, which is what makes the
  // vault a graph instead of a list. Markdown links render fine in Obsidian but
  // do not create graph edges, so the index looked connected and wasn't.
  const lines = entries.map(
    (e) => `- [[memory/${e.slug}|${e.name}]]${e.hook ? ` — ${e.hook}` : ""}`,
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

/**
 * Everything `remember` refuses, as a pure function.
 *
 * Extracted so the boundary can be tested. ADR-0101 turns on the claim that a
 * practice lesson without evidence is rejected AT THE WRITE BOUNDARY rather
 * than merely discouraged in a prompt — and this repo has measured prompt-only
 * guidance firing ~0×. An untested boundary is a claim, not a guarantee.
 *
 * Returns the rejection message, or null when the payload is acceptable.
 */
export function validateRememberPayload(input: {
  hook: string;
  body?: string;
  type?: (typeof TYPE_ENUM)[number];
}): string | null {
  const hookOneLine = input.hook.replace(/\s+/g, " ").trim();
  if (hookOneLine.length > MAX_HOOK_CHARS) {
    return (
      `Hook is ${hookOneLine.length} chars (max ${MAX_HOOK_CHARS}). memory is a ` +
      `one-line-per-fact index — tighten it to the essential invariant/gotcha.`
    );
  }
  const bodyText = (input.body ?? "").trim();
  if (bodyText.length > MAX_BODY_CHARS) {
    return (
      `Body is ${bodyText.length} chars (max ${MAX_BODY_CHARS}). If it needs more, ` +
      `it's probably a decision (→ ADR) or an implementation trail (→ git/changelog), ` +
      `not a memory fact.`
    );
  }
  if (input.type === "practice" && bodyText.length < MIN_PRACTICE_BODY_CHARS) {
    return (
      `Rejected — a practice lesson must cite the evidence behind it ` +
      `(body is ${bodyText.length} chars, needs ${MIN_PRACTICE_BODY_CHARS}). ` +
      `Say what was tried, what happened, and what to do instead. ` +
      `"Prefer X over Y" with nothing behind it is advice, not a lesson, ` +
      `and unevidenced advice is how a memory store becomes noise (ADR-0101).`
    );
  }
  const haystack = `${hookOneLine}\n${bodyText}`;
  for (const { re, why } of BANNED_PATTERNS) {
    if (re.test(haystack)) {
      return (
        `Rejected — this reads like activity/status, not a durable fact (${why}). ` +
        `memory.md holds only what's NOT re-derivable from ADRs/git/changelog ` +
        `(ADR-0042). Record decisions in an ADR and status in git/changelog.`
      );
    }
  }
  return null;
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
      type: z.enum(TYPE_ENUM).optional().describe(
        "user | feedback | project | reference | practice. Default project. " +
          "`practice` = how to work in this project (\"tried X, it was wrong, " +
          "do Y\"); it requires a body citing what happened.",
      ),
    },
    async ({ name, hook, body, type }) => {
      const rejection = validateRememberPayload({ hook, body, type });
      if (rejection) return errorResult(rejection);
      const hookOneLine = hook.replace(/\s+/g, " ").trim();
      const bodyText = (body ?? "").trim();
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
        const count = await rewriteMemoryIndex(workDir);
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
    // ADR-0073 — in the turn-1 prompt, never deferred behind ToolSearch.
    alwaysLoad: true,
    tools: [rememberTool, recallTool],
  });
}
