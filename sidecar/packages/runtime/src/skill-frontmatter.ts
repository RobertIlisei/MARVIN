/**
 * Tiny YAML-frontmatter parser for SKILL.md. Only the top-level scalar `name:`
 * and `description:` keys matter; nested keys and arrays are not in the SKILL.md
 * schema. One copy, shared by the user-global index, the project-local list and
 * the git installer — three private copies each read `description: >` as the
 * description ">" (UX review R2-15).
 *
 * Handles the scalar forms a description is written in: plain / quoted one-liners,
 * block scalars (`>` folded, `|` literal, with `-` / `+` chomping and an optional
 * indentation digit) and a plain scalar continued on indented lines.
 * Returns `{}` when there is no frontmatter or it is not terminated.
 */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---", 4);
  if (end < 0) return {};
  const lines = text.slice(4, end).split("\n");
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(/^(\w+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    const block = rest.match(/^([>|])[-+]?\d?\s*(?:#.*)?$/);
    // Everything indented under the key belongs to it. A blank line stays
    // inside the block; the first non-blank line at column 0 ends it.
    const body: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? "";
      if (next.trim() !== "" && !/^\s/.test(next)) break;
      body.push(next);
      i++;
    }
    let value: string;
    if (block) {
      value = block[1] === ">" ? foldLines(body) : literalLines(body);
    } else {
      const cont = foldLines(body);
      value = (cont ? `${rest} ${cont}` : rest).trim().replace(/^['"](.*)['"]$/, "$1");
    }
    if (key === "name" || key === "description") out[key] = value;
  }
  return out;
}

/** Trailing blank lines are chomped; the common indent is removed. */
function dedent(body: string[]): string[] {
  const lines = [...body];
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  const indents = lines.filter((l) => l.trim() !== "").map((l) => (l.match(/^\s*/)?.[0] ?? "").length);
  const strip = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(strip, l.length)).trimEnd());
}

/** YAML folding: a line break between two text lines is a space; a blank line is a line break. */
function foldLines(body: string[]): string {
  let out = "";
  let pendingBreaks = 0;
  for (const line of dedent(body)) {
    if (line === "") {
      pendingBreaks++;
      continue;
    }
    if (out !== "") out += pendingBreaks > 0 ? "\n".repeat(pendingBreaks) : " ";
    out += line;
    pendingBreaks = 0;
  }
  return out;
}

function literalLines(body: string[]): string {
  return dedent(body).join("\n");
}
