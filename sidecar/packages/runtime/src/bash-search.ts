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

// ---------------------------------------------------------------------------
// ADR-0124 — Bash source READS, not only searches
// ---------------------------------------------------------------------------

/**
 * Measured 2026-09-30 on four agri-saas-platform tabs: for every graph call a
 * tab ran ~3 shell reads or greps of source files — `sed -n 1,400p x.tsx`,
 * `cat routes/_layout.tsx`, `grep -rn … src --include='*.tsx'`. `bashSearchTarget`
 * above only saw a search binary LEADING a segment, so a `cat` or `sed` of a
 * whole file was invisible to the gate and to the ratio. This classifier sees
 * both, and says how wide each one is, so the gate can let a narrow read of a
 * line range through while refusing a whole-file dump or a repo-wide grep.
 */

/** A line-range read at or below this many lines is "narrow". */
export const NARROW_READ_MAX_LINES = 200;

export interface BashSourceAccess {
  /** `read` prints file content; `search` scans a tree or a file for matches. */
  kind: "read" | "search";
  /** The binary (`sed`, `rg`, …). */
  tool: string;
  /** Absolute paths of the source files named as operands. */
  files: string[];
  /** Absolute directories a search walks. Empty for a file-targeted search. */
  dirs: string[];
  /** A line-range read of at most `NARROW_READ_MAX_LINES` lines. */
  narrow: boolean;
  /** Lines a narrow read asks for; null otherwise. */
  lines: number | null;
  /** The pipeline stage, trimmed and capped, for messages. */
  segment: string;
}

const READ_TOOLS = new Set(["cat", "nl", "less", "more", "bat", "head", "tail", "sed", "awk"]);
const SEARCH_TOOLS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep", "ag", "ack", "find", "fd"]);

/** Directories whose content is never source the graph indexes — build output,
 *  dependencies, VCS internals, test reports, the graph itself. */
const EXCLUDED_DIRS = new Set([
  "node_modules", ".git", "graphify-out", "dist", "build", ".next", ".turbo", "target", "coverage",
  "test-results", "playwright-report", "blob-report", ".venv", "venv", "__pycache__", ".build",
  "DerivedData", ".gradle", ".pytest_cache", ".cache", "out",
]);

/** Leading words that do not change which binary a stage runs. */
const PREFIX_WORDS = new Set(["do", "then", "else", "{", "(", "!", "time", "command", "sudo", "nohup", "exec", "builtin"]);

interface Stage {
  text: string;
  /** 0 for the first stage of a pipeline; >0 downstream of a `|`. */
  pipeIndex: number;
}

/** Remove heredoc BODIES; the introducing line stays (with its `<<`). */
function stripHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  const pending: string[] = [];
  for (const line of lines) {
    if (pending.length > 0) {
      const t = line.replace(/^\t+/, "").trim();
      if (t === pending[0]) pending.shift();
      continue;
    }
    out.push(line);
    const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) pending.push(m[2] as string);
  }
  return out.join("\n");
}

/** Split into pipeline stages at `&&`, `||`, `;`, `&`, newline and `|`,
 *  honouring quotes, escapes and `$(…)` nesting. */
function splitStages(command: string): Stage[] {
  const stages: Stage[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let pipeIndex = 0;
  const flush = (nextPipe: number) => {
    if (buf.trim()) stages.push({ text: buf.trim(), pipeIndex });
    buf = "";
    pipeIndex = nextPipe;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const n = command[i + 1];
    if (quote) {
      if (c === "\\" && quote === '"') {
        buf += c + (n ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === "\\") {
      buf += c + (n ?? "");
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "$" && n === "(") {
      depth++;
      buf += "$(";
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      buf += c;
      continue;
    }
    if ((c === "&" && n === "&") || (c === "|" && n === "|")) {
      flush(0);
      i++;
      continue;
    }
    if (c === "|") {
      const next = pipeIndex + 1;
      flush(next);
      continue;
    }
    if (c === ";" || c === "\n") {
      flush(0);
      continue;
    }
    if (c === "&" && n !== ">" && command[i - 1] !== ">" && command[i - 1] !== "<") {
      flush(0);
      continue;
    }
    buf += c;
  }
  flush(0);
  return stages;
}

/** Quote-aware word split; quotes are removed. */
function stageWords(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)/g;
  let cur = "";
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Adjacent pieces (`--glob='*.ts'`) belong to one word.
    const piece = m[1] ?? m[2] ?? m[3] ?? "";
    if (last === m.index && cur) cur += piece;
    else {
      if (cur || last !== -1) out.push(cur);
      cur = piece;
    }
    last = re.lastIndex;
  }
  if (last !== -1) out.push(cur);
  return out.filter((w, i) => w !== "" || i > 0);
}

/** Drop redirections and their targets; report whether a heredoc/herestring feeds the stage. */
function dropRedirections(words: string[]): { words: string[]; heredoc: boolean; writes: boolean } {
  const out: string[] = [];
  let heredoc = false;
  let writes = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (/^\d*<<-?/.test(w) || w === "<<<") {
      heredoc = true;
      if (/^\d*<<-?$/.test(w) || w === "<<<") i++;
      continue;
    }
    if (/^(\d*|&)>>?(&\d+)?$/.test(w) || /^\d*<$/.test(w)) {
      if (w.includes(">") && !/&\d+$/.test(w)) writes = true;
      if (!/&\d+$/.test(w)) i++; // the target word
      continue;
    }
    if (/^(\d*|&)>>?\S/.test(w)) {
      if (!/^\d*>&\d+$/.test(w)) writes = true;
      continue;
    }
    if (/^\d*<\S/.test(w)) continue;
    out.push(w);
  }
  return { words: out, heredoc, writes };
}

function extOf(p: string): string {
  return extname(p.replace(/[*?]+$/, "")).toLowerCase();
}

/** True when the path runs through a directory the graph never indexes. */
function inExcludedDir(abs: string): boolean {
  return abs.split("/").some((seg) => EXCLUDED_DIRS.has(seg));
}

function resolveFrom(dir: string, p: string): string {
  if (p === "~" || p.startsWith("~/")) return join(process.env.HOME ?? "/", p.slice(1));
  return isAbsolute(p) ? p : join(dir, p);
}

/** Classify one operand path. A glob (`src/<star><star>/<star>.ts`) is a walk of its fixed prefix. */
function classifyOperand(
  abs: string,
  root: string,
): { kind: "source-file" | "dir"; path: string } | null {
  if (!isInsideCwd(root, abs)) return null;
  if (inExcludedDir(relative(root, abs))) return null;
  const glob = /[*?[{]/.test(abs);
  const ext = extOf(abs);
  if (glob) {
    if (ext && !SOURCE_FILE_EXTENSIONS.has(ext)) return null;
    const fixed = abs.split("/");
    const at = fixed.findIndex((seg) => /[*?[{]/.test(seg));
    return { kind: "dir", path: fixed.slice(0, at).join("/") || "/" };
  }
  if (ext) return SOURCE_FILE_EXTENSIONS.has(ext) ? { kind: "source-file", path: abs } : null;
  return { kind: "dir", path: abs };
}

const GREP_VALUE_FLAGS_ALL = new Set([
  "-e", "--regexp", "-f", "--file", "-m", "--max-count", "-A", "--after-context", "-B", "--before-context",
  "-C", "--context", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "--include", "--exclude",
  "--exclude-dir", "-M", "--max-columns", "-j", "--threads", "--color", "--colors", "-E", "--encoding",
  "--max-depth", "--maxdepth", "-d", "--sort", "--sortr", "--type-add", "--ignore-file", "--pre", "--pre-glob",
]);
// `-E` is a VALUE flag only for rg (encoding); for grep it is extended-regex. Handled per tool below.

const NON_SOURCE_TYPES = new Set(["md", "markdown", "json", "yaml", "yml", "toml", "txt", "log", "html", "css", "csv", "xml", "sql", "sh"]);

/** Globs / `--include` / `-t` values that restrict a search to non-source files. */
function restrictsToNonSource(values: string[], types: string[]): boolean {
  if (values.length === 0 && types.length === 0) return false;
  const globsNonSource = values.every((v) => {
    const cleaned = v.replace(/^!/, "");
    const ext = extOf(cleaned.replace(/\}$/, ""));
    if (cleaned.includes("{")) {
      const inner = /\{([^}]*)\}/.exec(cleaned)?.[1] ?? "";
      return inner.split(",").every((e) => !SOURCE_FILE_EXTENSIONS.has(`.${e.replace(/^\./, "")}`));
    }
    return !!ext && !SOURCE_FILE_EXTENSIONS.has(ext);
  });
  const typesNonSource = types.every((t) => NON_SOURCE_TYPES.has(t.toLowerCase()));
  return globsNonSource && typesNonSource;
}

/** Parse the head/tail line count. Returns null for "whole" shapes. */
function headTailLines(tool: "head" | "tail", args: string[]): { lines: number | null; follow: boolean; operands: string[] } {
  let lines: number | null = 10;
  let follow = false;
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "-f" || a === "-F" || a === "--follow") {
      follow = true;
      continue;
    }
    if (a === "-n" || a === "--lines" || a === "-c" || a === "--bytes") {
      const v = args[++i] ?? "";
      lines = parseCount(v, tool, a.startsWith("-c") || a === "--bytes");
      continue;
    }
    const eq = /^--(lines|bytes)=(.+)$/.exec(a);
    if (eq) {
      lines = parseCount(eq[2] as string, tool, eq[1] === "bytes");
      continue;
    }
    const attached = /^-([nc])(.+)$/.exec(a);
    if (attached) {
      lines = parseCount(attached[2] as string, tool, attached[1] === "c");
      continue;
    }
    if (/^-\d+$/.test(a)) {
      lines = Number(a.slice(1));
      continue;
    }
    if (a.startsWith("-")) continue;
    operands.push(a);
  }
  return { lines, follow, operands };
}

function parseCount(v: string, tool: "head" | "tail", bytes: boolean): number | null {
  if (bytes) return 1; // a byte slice is never a whole file in practice
  if (tool === "tail" && v.startsWith("+")) return null; // from line N to the end
  if (tool === "head" && v.startsWith("-")) return null; // all but the last N
  const n = Number(v.replace(/^[+-]/, ""));
  return Number.isFinite(n) ? n : null;
}

/** Lines a `sed -n` script prints, when it is only line ranges; null otherwise. */
function sedRangeLines(script: string): number | null {
  const parts = script.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  let total = 0;
  let sawPrint = false;
  for (const p of parts) {
    if (/^\d*q$/.test(p)) continue;
    const range = /^(\d+)\s*,\s*(\d+)\s*p$/.exec(p);
    if (range) {
      total += Math.max(0, Number(range[2]) - Number(range[1]) + 1);
      sawPrint = true;
      continue;
    }
    const plus = /^(\d+)\s*,\s*\+(\d+)\s*p$/.exec(p);
    if (plus) {
      total += Number(plus[2]) + 1;
      sawPrint = true;
      continue;
    }
    if (/^\d+\s*p$/.test(p)) {
      total += 1;
      sawPrint = true;
      continue;
    }
    return null;
  }
  return sawPrint ? total : null;
}

/** Lines an awk `NR` range prints; null when it is not a bare range. */
function awkRangeLines(script: string): number | null {
  const s = script.replace(/\s+/g, "");
  const both = /^NR>(=?)(\d+)&&NR<(=?)(\d+)(\{print\}?|\{print\$0\})?$/.exec(s);
  if (both) {
    const lo = Number(both[2]) + (both[1] ? 0 : 1);
    const hi = Number(both[4]) - (both[3] ? 0 : 1);
    return Math.max(0, hi - lo + 1);
  }
  const pair = /^NR==(\d+),NR==(\d+)(\{print\}?|\{print\$0\})?$/.exec(s);
  if (pair) return Math.max(0, Number(pair[2]) - Number(pair[1]) + 1);
  return null;
}

/**
 * Every source read or search a Bash command performs inside `root`.
 *
 * `sessionCwd` is where relative paths start (a tab's worktree); `root` is the
 * containment boundary (the project). Never classifies what is not a source
 * read: tests, builds, git, `wc`, `ls`, logs, `/tmp`, build output, heredoc
 * writes, `sed -i` edits and filters downstream of a pipe all return nothing.
 */
export function classifyBashSourceAccess(command: string, sessionCwd: string, root: string = sessionCwd): BashSourceAccess[] {
  if (!command.trim()) return [];
  const out: BashSourceAccess[] = [];
  let dir = sessionCwd;
  const loopVars = new Map<string, string[]>();
  let prevStageSearchesTree = false;

  for (const stage of splitStages(stripHeredocs(command))) {
    const raw = stageWords(stage.text);
    const { words, heredoc, writes } = dropRedirections(raw);
    let i = 0;
    while (i < words.length && (PREFIX_WORDS.has(words[i] as string) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string))) i++;
    const head = (words[i] ?? "").split("/").pop() ?? "";
    let args = words.slice(i + 1);

    if (head === "cd") {
      const target = args[0];
      if (target && target !== "-") dir = resolveFrom(dir, target);
      continue;
    }
    if (head === "for") {
      const inIdx = args.indexOf("in");
      if (args[0] && inIdx === 1) loopVars.set(args[0], args.slice(2));
      continue;
    }

    let tool = head;
    let viaXargs = false;
    if (head === "xargs") {
      let j = 0;
      while (j < args.length && (args[j] as string).startsWith("-")) {
        if (/^-(n|I|L|P|s|d|E)$/.test(args[j] as string)) j++;
        j++;
      }
      tool = ((args[j] ?? "").split("/").pop() ?? "");
      args = args.slice(j + 1);
      viaXargs = true;
    }
    const isRead = READ_TOOLS.has(tool);
    const isSearch = SEARCH_TOOLS.has(tool);
    if (!isRead && !isSearch) {
      // `git ls-files | xargs grep` searches the tree through stdin.
      prevStageSearchesTree = stage.pipeIndex === 0 && /^(git\s+ls-files|find|fd|rg\s+-l|rg\s+--files|grep\s+-[a-zA-Z]*l)/.test(stage.text);
      continue;
    }
    // A filter downstream of a pipe reads the previous stage's output, not a file.
    if (stage.pipeIndex > 0 && !viaXargs) continue;
    if (heredoc) continue; // `cat <<EOF > x` writes; it reads nothing from the tree

    // `$f` inside `for f in a b c` stands for the loop list.
    const expand = (w: string): string[] => {
      const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(w);
      if (!v) return [w];
      return loopVars.get(v[1] as string) ?? [];
    };
    const segment = truncate(stage.text, 120);
    const pushAccess = (a: Omit<BashSourceAccess, "segment" | "tool">) => {
      if (a.files.length === 0 && a.dirs.length === 0) return;
      if (stage.pipeIndex === 0 && a.kind === "search") prevStageSearchesTree = true;
      out.push({ ...a, tool, segment });
    };
    const sortOperands = (ops: string[]): { files: string[]; dirs: string[] } => {
      const files: string[] = [];
      const dirs: string[] = [];
      for (const op of ops.flatMap(expand)) {
        if (!op || op === "-" || op.startsWith("$")) continue;
        const abs = resolveFrom(dir, op);
        const c = classifyOperand(abs, root);
        if (c?.kind === "source-file") files.push(c.path);
        else if (c?.kind === "dir") dirs.push(c.path);
      }
      return { files, dirs };
    };

    if (viaXargs) {
      if (prevStageSearchesTree && isInsideCwd(root, dir) && !inExcludedDir(relative(root, dir))) {
        pushAccess({ kind: isSearch ? "search" : "read", files: [], dirs: [dir], narrow: false, lines: null });
      }
      continue;
    }

    if (tool === "sed") {
      if (args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place" || a.startsWith("--in-place"))) continue;
      const quiet = args.some((a) => a === "-n" || a === "--quiet" || a === "--silent" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
      const scripts: string[] = [];
      const ops: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k] as string;
        if (a === "-e" || a === "--expression") {
          scripts.push(args[++k] ?? "");
          continue;
        }
        if (a === "-f") {
          k++;
          continue;
        }
        if (a.startsWith("-")) continue;
        ops.push(a);
      }
      if (scripts.length === 0 && ops.length > 0) scripts.push(ops.shift() as string);
      const { files } = sortOperands(ops);
      if (files.length === 0) continue;
      const script = scripts.join(";");
      const range = quiet ? sedRangeLines(script) : null;
      if (range !== null) {
        pushAccess({ kind: "read", files, dirs: [], narrow: range <= NARROW_READ_MAX_LINES, lines: range });
      } else if (quiet && /^\/.*\/p$/.test(script.trim())) {
        pushAccess({ kind: "search", files, dirs: [], narrow: false, lines: null });
      } else {
        pushAccess({ kind: "read", files, dirs: [], narrow: false, lines: null });
      }
      continue;
    }
    if (tool === "head" || tool === "tail") {
      const { lines, follow, operands } = headTailLines(tool, args);
      if (follow) continue;
      const { files } = sortOperands(operands);
      const narrow = lines !== null && lines <= NARROW_READ_MAX_LINES;
      pushAccess({ kind: "read", files, dirs: [], narrow, lines: narrow ? lines : null });
      continue;
    }
    if (tool === "awk") {
      const ops: string[] = [];
      let script: string | null = null;
      for (let k = 0; k < args.length; k++) {
        const a = args[k] as string;
        if (a === "-F" || a === "-v" || a === "-f") {
          if (a === "-f") script = "";
          k++;
          continue;
        }
        if (a.startsWith("-")) continue;
        if (script === null) script = a;
        else ops.push(a);
      }
      const { files } = sortOperands(ops);
      const range = script ? awkRangeLines(script) : null;
      if (range !== null) {
        pushAccess({ kind: "read", files, dirs: [], narrow: range <= NARROW_READ_MAX_LINES, lines: range });
      } else if (script && /^\s*\//.test(script)) {
        pushAccess({ kind: "search", files, dirs: [], narrow: false, lines: null });
      } else {
        pushAccess({ kind: "read", files, dirs: [], narrow: false, lines: null });
      }
      continue;
    }
    if (isRead) {
      // cat / nl / less / more / bat — whole files. `cat > f` with no operand writes.
      const ops = args.filter((a) => !a.startsWith("-"));
      if (writes && ops.length === 0) continue;
      const { files } = sortOperands(ops);
      pushAccess({ kind: "read", files, dirs: [], narrow: false, lines: null });
      continue;
    }

    // ── searches ──
    if (tool === "find" || tool === "fd") {
      const ops: string[] = [];
      const names: string[] = [];
      if (tool === "find") {
        let k = 0;
        while (k < args.length && !(args[k] as string).startsWith("-") && !["(", "!"].includes(args[k] as string)) ops.push(args[k++] as string);
        for (; k < args.length; k++) {
          if (["-name", "-iname", "-path", "-ipath"].includes(args[k] as string)) names.push(args[++k] ?? "");
        }
        if (ops.length === 0) ops.push(".");
      } else {
        const pos = args.filter((a) => !a.startsWith("-"));
        const exts: string[] = [];
        for (let k = 0; k < args.length; k++) {
          if (args[k] === "-e" || args[k] === "--extension") exts.push(`*.${args[++k] ?? ""}`);
        }
        names.push(...exts);
        ops.push(pos[1] ?? ".");
      }
      if (names.length > 0 && restrictsToNonSource(names.filter((n) => /\.[A-Za-z0-9]+$/.test(n)), [])) {
        if (names.every((n) => /\.[A-Za-z0-9]+$/.test(n))) continue;
      }
      const { files, dirs } = sortOperands(ops);
      pushAccess({ kind: "search", files, dirs, narrow: false, lines: null });
      continue;
    }

    // grep family / rg / ag / ack
    const isRg = tool === "rg" || tool === "ripgrep";
    const globs: string[] = [];
    const types: string[] = [];
    const positional: string[] = [];
    let patternGiven = false;
    let recursive = isRg || tool === "ag" || tool === "ack";
    for (let k = 0; k < args.length; k++) {
      const a = args[k] as string;
      if (a === "--") {
        positional.push(...args.slice(k + 1));
        break;
      }
      const eq = /^(--[a-z-]+)=(.*)$/.exec(a);
      if (eq) {
        const [, flag, value] = eq as unknown as [string, string, string];
        if (flag === "--include" || flag === "--glob" || flag === "--iglob") globs.push(value);
        if (flag === "--type") types.push(value);
        if (flag === "--regexp") patternGiven = true;
        continue;
      }
      if (a === "-e" || a === "--regexp" || a === "-f" || a === "--file") {
        patternGiven = true;
        k++;
        continue;
      }
      if (a === "-g" || a === "--glob" || a === "--iglob" || a === "--include") {
        globs.push(args[++k] ?? "");
        continue;
      }
      if (a === "-t" || a === "--type") {
        types.push(args[++k] ?? "");
        continue;
      }
      if (a === "-E" && !isRg) continue; // grep's extended-regex switch
      if (GREP_VALUE_FLAGS_ALL.has(a)) {
        k++;
        continue;
      }
      if (/^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a) || a === "--recursive" || a === "--dereference-recursive") recursive = true;
      if (/^-[a-zA-Z]*[efmABC]$/.test(a) && a.length > 2) {
        // `-nA3`-style bundles never swallow the next word; `-rne` would.
        if (a.endsWith("e") || a.endsWith("f")) {
          patternGiven = true;
          k++;
        } else if (/[mABC]$/.test(a)) {
          k++;
        }
        continue;
      }
      if (a.startsWith("-")) continue;
      positional.push(a);
    }
    const ops = patternGiven ? positional : positional.slice(1);
    if (restrictsToNonSource(globs, types)) continue;
    if (ops.length === 0) {
      // No path: `grep -r` walks `.`; everything else reads stdin, which in
      // MARVIN's shell never closes — ADR-0120's gate owns that shape.
      if (!recursive || isRg || tool === "ag" || tool === "ack") continue;
      ops.push(".");
    }
    const { files, dirs } = sortOperands(ops);
    pushAccess({ kind: "search", files, dirs, narrow: false, lines: null });
  }
  return out;
}
