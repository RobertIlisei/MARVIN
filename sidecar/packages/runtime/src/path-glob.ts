/**
 * A small path-glob matcher for practice-rule `paths` (ADR-0138).
 *
 * The repo had none. A rule row is user data, so this is deliberately tiny and
 * linear: `**` crosses directories, `*` and `?` stay inside one, everything
 * else is literal, and a pattern that is a plain directory matches everything
 * under it. A pattern with no `/` matches the file NAME at any depth
 * (`*.sql`), one with a `/` is anchored at the repository root.
 */

export const GLOBS_MAX = 20;
export const GLOB_MAX_LENGTH = 200;

/** The segment a glob compiles to. `*` runs are collapsed first, so a pattern
 *  like `********x` cannot make the regex backtrack catastrophically. */
function compile(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const anywhere = !p.includes("/");
  p = p.replace(/\*{3,}/g, "**");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*") {
      if (p[i + 1] === "*") {
        i += 1;
        if (p[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?"; // `**/` is zero or more directories
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${anywhere ? "(?:.*/)?" : ""}${out}(?:/.*)?$`);
}

/** Does repo-relative `path` (forward slashes) match `pattern`? */
export function matchesGlob(path: string, pattern: string): boolean {
  try {
    return compile(pattern).test(path.replace(/\\/g, "/").replace(/^\.\//, ""));
  } catch {
    return false;
  }
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesGlob(path, p));
}

/** A list of globs read from a user-editable file: strings only, trimmed,
 *  bounded in count and length, no NUL, deduplicated, `./` and a trailing `/`
 *  dropped. Never throws. */
export function sanitizeGlobs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const s = item.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!s || s.length > GLOB_MAX_LENGTH || s.includes("\0") || out.includes(s)) continue;
    out.push(s);
    if (out.length >= GLOBS_MAX) break;
  }
  return out;
}
