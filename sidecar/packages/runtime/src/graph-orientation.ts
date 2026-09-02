/**
 * Graph pre-orientation (ADR-0105 follow-up, 2026-09-03).
 *
 * The practice backtest over 397 sessions put the graphify-first gate at the
 * top of the list: **1655 denies across 172 sessions** — roughly one per
 * turn, because nearly every turn's first act is a file read and the gate
 * refuses it until the graph has been queried. Measured across the last 120
 * sessions, what followed a deny: 36 % a graph call (the rule working), 31 %
 * a `ToolSearch` for the graph tool first (a wasted round-trip — the tool is
 * already loaded), 32 % another file op. At ~650K tokens of context a deny
 * round-trip is a model call the user pays for.
 *
 * So the runtime does the orientation itself. Before the turn starts, it runs
 * the same search the model would have been told to run — the user's message
 * as the query — and rides the top hits on the prompt as a system-reminder.
 * That counts as the turn's first graph call: the deny never fires, the
 * model starts with the graph's answer in hand, and the drift budget (ADR-0060)
 * starts fresh. Pure functions here; `sdk-runner` owns the graph read.
 */

import type { SearchHit } from "@marvin/graphify-bridge";

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by as is are was were be been being it its this that these those " +
    "i you we they he she me my your our their can could should would will shall may might must do does did done have has " +
    "had not no yes please now then than so if when where which who whom what why how also just only into onto about over " +
    "under again more most some any all each every both few many much very too here there again let lets us make made " +
    "need needs want wants like new old same other another via per using use used continue proceed go ok okay fix add remove " +
    "update change check look see run show tell give get set put try still yet"
  ).split(/\s+/),
);

/** Terms worth searching the graph for, or null when the message is not a
 *  task (a bare "continue", a slash command, a wakeup, an attachment). */
export function buildOrientationQuery(message: string): string | null {
  const text = message.trim();
  if (!text || text.startsWith("/") || text.startsWith("[")) return null;
  const words = text
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/@\S+/g, " ")
    .split(/[^A-Za-z0-9_./-]+/)
    .map((w) => w.trim().replace(/^[./-]+|[./-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()) && !/^\d+$/.test(w));
  if (words.length < 2) return null;
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of words) {
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    terms.push(k);
    if (terms.length >= 12) break;
  }
  return terms.join(" ");
}

/** The system-reminder block, or null when there is nothing to say. */
export function formatOrientation(query: string, hits: SearchHit[], limit = 8): string | null {
  const top = hits.slice(0, limit);
  if (top.length === 0) return null;
  const lines = top.map((h) => {
    const where = h.sourceFile ? ` — \`${h.sourceFile}\`` : "";
    return `- **${h.label}**${where} (${h.degree} edge${h.degree === 1 ? "" : "s"})`;
  });
  return (
    "Graph orientation (run by the runtime before this turn; it counts as your first graph call). " +
    `\`graph_search\` for \`${query}\` — the most connected matches:\n` +
    `${lines.join("\n")}\n` +
    "Start from these. `graph_affected` on a symbol before you change it; `graph_search` with a narrower " +
    "query if none of these is the thing. The graph tools are loaded — call them directly, no ToolSearch."
  );
}
