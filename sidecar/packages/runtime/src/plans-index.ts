/**
 * plans-index — a vault index for `.marvin/plans/` (ADR-0091).
 *
 * `memory.md` and `backlog.md` each wikilink their notes, so both families are
 * hubs in the Obsidian graph. Plans had no equivalent: measured on a real
 * project, **353 plan notes with not one inbound link** — invisible to the
 * graph view, to backlinks, and to Dataview, while `MARVIN.md` mentioned them
 * in prose only.
 *
 * Deliberately mirrors `rewriteMemoryIndex`: same wikilink form (ADR-0065 —
 * markdown links render but create no graph edge), same regenerate-in-place
 * contract, same tolerance for a missing directory.
 *
 * Plans have no frontmatter — they open with `# Plan — <title>` and carry
 * `- [ ]` / `- [x]` checkboxes — so the title and progress are parsed from the
 * body. That parsing is the part worth testing.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INDEX_HEADER = "# Plans";

export interface PlanSummary {
  slug: string;
  title: string;
  done: number;
  total: number;
}

/**
 * Title and checkbox progress from a plan's markdown.
 *
 * The title is the first `# ` heading, with a leading `Plan — ` stripped so
 * the index reads as a list of plans rather than 353 repetitions of the word.
 * Checkboxes are counted at any indent, because ADR-0046 sub-tasks nest under
 * their step and both count as work.
 */
export function summarisePlan(slug: string, content: string): PlanSummary {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? "";
  const title = heading.replace(/^Plan\s*[—–-]\s*/, "").trim() || slug.replace(/-/g, " ");
  const boxes = content.match(/^\s*[-*]\s+\[( |x|X)\]/gm) ?? [];
  const done = boxes.filter((b) => /\[[xX]\]/.test(b)).length;
  return { slug, title, done, total: boxes.length };
}

/** `3/6` → a short progress marker; empty when a plan has no checkboxes. */
export function progressLabel(p: PlanSummary): string {
  if (p.total === 0) return "";
  return p.done >= p.total ? `✓ ${p.done}/${p.total}` : `${p.done}/${p.total}`;
}

/**
 * Regenerate `.marvin/plans.md`. Returns the number of plans indexed.
 *
 * Newest first: a plans list is read to find recent work, not alphabetically.
 */
export async function rewritePlansIndex(workDir: string): Promise<number> {
  const dir = join(workDir, ".marvin", "plans");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return 0;
  }
  if (files.length === 0) return 0;

  const withTime: Array<{ plan: PlanSummary; mtime: number }> = [];
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    try {
      const content = await readFile(join(dir, f), "utf-8");
      const { mtimeMs } = await import("node:fs").then((m) => m.promises.stat(join(dir, f)));
      withTime.push({ plan: summarisePlan(slug, content), mtime: mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  withTime.sort((a, b) => b.mtime - a.mtime);

  const lines = withTime.map(({ plan }) => {
    const progress = progressLabel(plan);
    return `- [[plans/${plan.slug}|${plan.title}]]${progress ? ` — ${progress}` : ""}`;
  });

  const body =
    `${INDEX_HEADER}\n\n` +
    `One line per plan in \`.marvin/plans/\`, newest first, with checkbox ` +
    `progress. The app owns these files (ADR-0052) — it renders the tracked ` +
    `plan spine into them, so edit the plan through MARVIN rather than here.\n\n` +
    `${lines.join("\n")}\n`;

  await writeFile(join(workDir, ".marvin", "plans.md"), body, "utf-8");
  return withTime.length;
}
