import { extname, isAbsolute, join, relative } from "node:path";

/**
 * What counts as a structural read — shared by the graphify-first gate
 * (`design-hooks.ts`) and the practice extractor that measures the same act
 * after the fact (`practice-extractors.ts`). One definition, so the nightly
 * report and the live rail can never disagree about what a "source read" is
 * (2026-09-07: they did — the extractor counted `cat docs/x.md`, the gate
 * did not).
 */

/** Source file extensions that the graphify-first rule applies to. The
 *  rule is about *structural* reads — config / docs / data files don't
 *  trigger graph-first because they're not what the graph indexes. */
const SOURCE_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".swift",
  ".py",
  ".go",
  ".rs",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".java",
  ".kt",
  ".kts",
  ".rb",
  ".ex",
  ".exs",
  ".cs",
  ".m",
  ".mm",
]);

/** Search commands that ARE structural exploration of the tree. */
const BASH_SEARCH_COMMANDS = new Set([
  "rg", "grep", "egrep", "fgrep", "ack", "ag", "find", "fd", "ripgrep",
]);

/**
 * The search root of a search-shaped `Bash` command, or null when the call is
 * not structural exploration.
 *
 * Why this exists (2026-08-30). Golden Rule 7's mechanical half keyed on
 * `Read` / `Grep` / `Glob`. Claude Code **2.1.251 removed `Grep` and `Glob`
 * from the main agent's tool surface** — verified by probing both bundled
 * CLIs directly: 2.1.113 reports them, 2.1.251 does not, and `ToolSearch`
 * answers `select:Grep,Glob` with "No matching deferred tools found", so they
 * are gone rather than deferred. Searching therefore moves to `Bash`, which
 * this rail could not see: measured across every session in the four hours
 * after the CLI upgrade, **15 of 18 Bash calls were search-shaped against 2
 * graph calls**. That is the "grep and pray" pattern the rule exists to
 * eliminate, routing around the mechanism built to stop it.
 *
 * Conservative on purpose, because `Bash` is mostly IMPLEMENTATION here
 * (tests, git, make) and the drift rails deliberately never interrupt that:
 *
 *   - only when a search binary LEADS a pipeline segment, so
 *     `make smoke | grep -i fail` (filtering command output) never fires
 *     while `grep -rn "x" src/` does;
 *   - only when the search root resolves inside `cwd`, matching what the
 *     `Grep` branch already required.
 */
export function bashSearchTarget(
  toolInput: Record<string, unknown>,
  cwd: string,
): string | null {
  const command = typeof toolInput.command === "string" ? toolInput.command : "";
  if (!command.trim()) return null;

  // Split on LIST separators only (`&&`, `||`, `;`, newline) — never on `|`.
  // A pipe is the whole distinction: `rg "x" src | head` searches the tree,
  // `make smoke | grep FAIL` filters command output and must never be denied.
  // So within each list segment we look at the FIRST pipeline stage only; a
  // search binary downstream of a pipe is a filter, not a search.
  for (const listSegment of command.split(/&&|\|\||;|\n/)) {
    const rawSegment = listSegment.split("|")[0] ?? "";
    const words = rawSegment.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    // Skip a leading `cd <dir>` — MARVIN's Bash calls routinely open with one.
    let i = 0;
    if (words[i] === "cd") i += 2;
    // Skip env assignments (FOO=bar) and common prefixes.
    while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]!) || words[i] === "command" || words[i] === "sudo")) i += 1;
    const head = (words[i] ?? "").split("/").pop() ?? "";
    if (!BASH_SEARCH_COMMANDS.has(head)) continue;

    // The first non-flag argument after the binary is the closest thing to a
    // search root. `grep -rn "pat" src/` → "src/"; `find . -name x` → ".".
    // `grep` takes the PATTERN first, so prefer the last path-ish argument;
    // `find` takes the path first. Either way, default to cwd, which is what
    // the `Grep` branch did when `path` was omitted.
    const args = words.slice(i + 1).filter((w) => !w.startsWith("-"));
    const pathish = head === "find" ? args[0] : args.slice(1).find((a) => a.includes("/") || a === "." || a === "..");
    const target = pathish ?? cwd;
    const resolved = target === "." || target === ".." ? cwd : target;
    if (isInsideCwd(cwd, resolved)) return `${head} ${truncate(rawSegment.trim(), 60)}`;
  }
  return null;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Check whether `target` is a regular source file (by extension). */
export function isSourceFile(target: string): boolean {
  return SOURCE_FILE_EXTENSIONS.has(extname(target).toLowerCase());
}

/** Check whether `target` resolves to a path inside `cwd`. Tolerates
 *  relative paths by treating them as relative to cwd. */
export function isInsideCwd(cwd: string, target: string): boolean {
  const abs = isAbsolute(target) ? target : join(cwd, target);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // Also treat empty string as inside (target === cwd).
  return true;
}
