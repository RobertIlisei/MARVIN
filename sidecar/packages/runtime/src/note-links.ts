/**
 * Derived `[[wikilinks]]` for MARVIN's notes (ADR-0065 addendum).
 *
 * Measured on a real project: 819 notes, 129 links — and every one of those was
 * index→item. Zero links between notes. Obsidian's graph view therefore showed
 * two starbursts rather than a network, and graphify's knowledge graph got no
 * cross-document edges from them either.
 *
 * The relationships were already there, written in prose. A backlog item's body
 * says "ADR-0211"; a memory fact names `site.yml`. Nothing was missing except
 * the syntax that makes a reference an EDGE.
 *
 * ## Derived, delimited, regenerated
 *
 * Links are appended below a marker and recomputed on every write — never
 * merged into the body the model or the user wrote. That keeps three promises:
 * the note's own text is never edited, the trailer can't accumulate duplicates,
 * and deleting the marker line is enough to be rid of it.
 *
 * ## Why resolution matters
 *
 * `[[ADR-0211]]` does not resolve to `docs/adr/0211-sentinel-group.md` — the
 * filenames don't match, so Obsidian renders an unresolved link: a node that
 * looks like a note but opens nothing. Resolving against the real files turns
 * the same reference into an edge to the actual ADR. Where a reference can't be
 * resolved it is left out entirely rather than emitted as a dead end.
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { extractPathRefs } from "./backlog";

/** Everything below this line in a note body is generated. */
export const LINK_MARKER = "<!-- marvin:links -->";

/** Where ADRs live, across the conventions MARVIN has seen. */
const ADR_DIRS = ["docs/adr", "docs/decisions"];

/**
 * Strip a previously generated trailer, returning the author's body alone.
 *
 * Called on parse so the trailer never counts toward the body cap, never shows
 * in the UI's body field, and never round-trips into itself.
 */
export function stripLinkTrailer(body: string): string {
  const at = body.indexOf(LINK_MARKER);
  return at === -1 ? body : body.slice(0, at).trimEnd();
}

/** Map `0211` → `docs/adr/0211-sentinel-group.md`, built once per pass. */
export type AdrIndex = Map<string, string>;

export async function buildAdrIndex(workDir: string): Promise<AdrIndex> {
  const index: AdrIndex = new Map();
  for (const dir of ADR_DIRS) {
    let names: string[];
    try {
      names = await readdir(join(workDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const num = /^(\d{3,4})[-_]/.exec(name)?.[1];
      // Keyed without leading zeros so "ADR-64" and "ADR-0064" both hit.
      if (num) index.set(String(Number(num)), `${dir}/${name.replace(/\.md$/, "")}`);
    }
  }
  return index;
}

export interface DerivedLinks {
  /** Wikilink targets, deduped and ordered: ADRs first, then files. */
  links: string[];
}

/**
 * Find the references in `text` that resolve to something real.
 *
 * `fileExists` is injected so this stays testable without a filesystem, and so
 * the caller controls what "real" means (project-relative, sandboxed).
 */
export function deriveLinks(
  text: string,
  adrIndex: AdrIndex,
  fileExists: (relPath: string) => boolean,
): DerivedLinks {
  const links: string[] = [];
  // Deduped on the note the link RESOLVES TO, with any `.md` stripped: an item
  // that says both "ADR-0211" and "docs/adr/0211-….md" refers to one note, and
  // emitting both produces a duplicate edge and a noisy trailer. Observed on
  // the first real relink pass.
  const seen = new Set<string>();
  const key = (target: string) => target.replace(/\.md$/, "");

  // ADR references, in any of the forms people actually write.
  for (const m of text.matchAll(/\bADR[-\s]?(\d{2,4})\b/gi)) {
    const adrNum = String(Number(m[1]));
    const path = adrIndex.get(adrNum);
    if (!path) continue; // unresolvable → omit rather than emit a dead end
    const label = `ADR-${m[1]}`;
    const link = `[[${path}|${label}]]`;
    if (!seen.has(key(path))) {
      seen.add(key(path));
      links.push(link);
    }
  }

  // File references — only paths carrying a directory, and only ones that
  // exist. A bare "README.md" can't be resolved to one file, and a link to a
  // file that was deleted is worse than no link.
  for (const ref of extractPathRefs(text)) {
    if (!ref.includes("/")) continue;
    if (seen.has(key(ref))) continue;
    if (!fileExists(ref)) continue;
    seen.add(key(ref));
    links.push(`[[${ref}]]`);
  }

  return { links };
}

/**
 * Render the trailer, or "" when nothing resolved.
 *
 * An empty trailer is omitted entirely — a note whose only addition is an empty
 * "Related:" heading is noise, and it would still create a diff on every write.
 */
export function renderLinkTrailer(links: string[]): string {
  if (links.length === 0) return "";
  return `\n\n${LINK_MARKER}\n**Related:** ${links.join(" · ")}\n`;
}

/** Convenience: derive + render against a real workDir. */
export function linkTrailerFor(
  text: string,
  workDir: string,
  adrIndex: AdrIndex,
): string {
  const { links } = deriveLinks(text, adrIndex, (rel) => existsSync(join(workDir, rel)));
  return renderLinkTrailer(links);
}
