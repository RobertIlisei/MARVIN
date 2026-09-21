/**
 * A directory's instruction files, read the way the agent ecosystem writes
 * them (ADR-0119).
 *
 * Claude Code reads `CLAUDE.md` (and `.claude/CLAUDE.md`); Codex, Cursor and
 * others read `AGENTS.md`; Anthropic's documented way to share one file is a
 * `CLAUDE.md` that says `@AGENTS.md`. MARVIN used to inject the root
 * `CLAUDE.md` verbatim — so an AGENTS.md-only project gave it no instructions
 * and an `@AGENTS.md` import reached the model as that literal line.
 *
 * Rules, matching Claude Code's documentation where it has one:
 * - `CLAUDE.md` / `.claude/CLAUDE.md` load; `AGENTS.md` / `.claude/AGENTS.md`
 *   load when there is no CLAUDE.md. When both exist MARVIN goes one step
 *   further than Claude Code's default: an AGENTS.md that is neither imported
 *   nor a near-copy of CLAUDE.md carries instructions CLAUDE.md does not, so it
 *   loads too. A near-copy (half or more of its lines already in CLAUDE.md —
 *   real duplicates measured 85–88 %, a genuinely different file 9 %) is
 *   skipped and reported, because loading it doubles the tokens for nothing.
 * - Never `CLAUDE.local.md` (a personal override — see DEFAULT_FILES in
 *   index.ts), `AGENTS.local.md`, `AGENTS.override.md` or anything in `.agents/`.
 * - `@path` imports expand relative to the importing file, outside fenced
 *   blocks and inline code, at most four hops, each file once. The file is
 *   project-controlled input, so an import whose real path leaves the project
 *   is refused (left in place with a marker) — including through a symlink.
 *   A token that resolves to nothing stays as written; it may be a mention.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export type InstructionRole = "loaded" | "imported" | "duplicate";

export interface ResolvedInstructions {
  /** One section per loaded file, imports already expanded inline. */
  sections: Array<{ path: string; text: string }>;
  /** Every file involved, in reading order. */
  files: Array<{ path: string; role: InstructionRole }>;
}

const CLAUDE_FILES = ["CLAUDE.md", join(".claude", "CLAUDE.md")];
const AGENTS_FILES = ["AGENTS.md", join(".claude", "AGENTS.md")];
const MAX_HOPS = 4;
/** Share of AGENTS.md's lines already in CLAUDE.md that makes it a copy. */
const DUPLICATE_CONTAINMENT = 0.5;

export function resolveInstructionFiles(dir: string, root: string): ResolvedInstructions {
  const out: ResolvedInstructions = { sections: [], files: [] };
  const realRoot = safeRealpath(root);
  if (!realRoot) return out;
  const seen = new Set<string>();

  const claude = CLAUDE_FILES.map((f) => join(dir, f)).filter(isFile);
  for (const path of claude) {
    const real = safeRealpath(path);
    if (!real || !inside(real, realRoot) || seen.has(real)) continue;
    seen.add(real);
    out.files.push({ path, role: "loaded" });
    out.sections.push({ path, text: expand(readFileSync(path, "utf-8"), path, realRoot, seen, out, 0) });
  }

  const claudeLines = new Set(out.sections.flatMap((s) => normalisedLines(s.text)));
  for (const path of AGENTS_FILES.map((f) => join(dir, f)).filter(isFile)) {
    const real = safeRealpath(path);
    if (!real || !inside(real, realRoot) || seen.has(real)) continue;
    const content = readFileSync(path, "utf-8");
    if (claude.length > 0 && containment(content, claudeLines) >= DUPLICATE_CONTAINMENT) {
      out.files.push({ path, role: "duplicate" });
      continue;
    }
    seen.add(real);
    out.files.push({ path, role: "loaded" });
    out.sections.push({ path, text: expand(content, path, realRoot, seen, out, 0) });
  }
  return out;
}

/** Expand `@path` tokens outside code, recursively, in place. */
function expand(
  content: string,
  from: string,
  realRoot: string,
  seen: Set<string>,
  out: ResolvedInstructions,
  hops: number,
): string {
  let fenced = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || hops >= MAX_HOPS) return line;
      // Split on inline code spans; only the even (non-code) parts are scanned.
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(/(^|\s)@([^\s`]+)/g, (whole, lead: string, target: string) => {
                const candidate = isAbsolute(target) ? target : resolve(dirname(from), target);
                if (!isFile(candidate)) return whole;
                const real = safeRealpath(candidate);
                if (!real || !inside(real, realRoot)) {
                  return `${whole} (not loaded: outside the project)`;
                }
                if (seen.has(real)) return lead;
                seen.add(real);
                out.files.push({ path: candidate, role: "imported" });
                const body = expand(readFileSync(candidate, "utf-8"), candidate, realRoot, seen, out, hops + 1);
                return `${lead}${body.trim()}`;
              }),
        )
        .join("");
    })
    .join("\n");
}

function normalisedLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function containment(text: string, reference: Set<string>): number {
  const lines = normalisedLines(text);
  if (lines.length === 0) return 1;
  return lines.filter((l) => reference.has(l)).length / lines.length;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot + sep);
}
