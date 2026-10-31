// vcs-command — every git / gh / glab invocation in a shell command, read the
// way the binary reads it.
//
// ## Why this exists
//
// The gate's integration checks — the ADR-0109 tab-branch deny, the metered-CI
// confirm, the ADR-0077 tag-push and force-push denies — were regexes over the
// raw command: `\bgit\s+push\b`, `\bglab\s+ci\s+run\b`. A global option between
// the tool and its verb walked past every one of them. `git -C . push` is not
// an exotic form: MARVIN reaches a worktree with `git -C <path>` all the time.
// Found by the security audit of 2026-10-31 and probed live.
//
// So the command is parsed: split into stages (the shared shell tokenizer),
// heredoc bodies, `$(…)`, backticks and quoted scripts (`bash -c '…'`) are read
// as commands of their own, and each git / gh / glab invocation has the options
// that only say WHERE it runs (`-C`, `-c`, `--git-dir`, `-R owner/repo`, …)
// moved out of the way. The result's `line` — `git push origin main` — is the
// form the gate's patterns were written against.
//
// ## What it will not guess
//
// An invocation that cannot be read confidently is marked `unclear`: an option
// this table does not know, an inline alias (`-c alias.p=push`,
// `-c help.autocorrect=1`, `GIT_CONFIG_*=… git p`), a shell expansion where
// the subcommand should be, or a binary chosen by `$(which git)`. Callers
// treat `unclear` as the risky class — a deny or a confirm, never an allow.
//
// Strict by default: an unlisted executor (`find -exec`, `ssh host`, `docker
// exec`) cannot launder a git through a lenient read. Only a stage run by a
// command that takes a PATTERN or a package name (`grep -n git file`,
// `rg git --type ts`, `brew upgrade gh`) reads its git / gh / glab leniently —
// still parsed, so `echo git push` counts as before, but never `unclear`.
//
// Deliberately conservative, and it stays that way: heredoc bodies and quoted
// strings are read as scripts, so a commit message that MENTIONS `git push`
// reads as one. The raw-text patterns did the same; do not loosen the parser
// to fix it — `bash <<EOF` and `sh -c '…'` are exactly those shapes.
//
// Beyond a static read: aliases from the user's config (`git config alias.p
// push`, then `git p`), config reached through `HOME` or an earlier `export`,
// and a binary named by a variable (`$GIT push`). A guardrail against the
// ordinary forms, not a sandbox.

import { splitStages, stageWords } from "./shell-words";

export type VcsTool = "git" | "gh" | "glab";

export interface VcsInvocation {
  tool: VcsTool;
  /** Options that select where the tool runs, removed from `args`:
   *  git's global options, gh / glab's `-R` / `--repo`. */
  globals: string[];
  /** Everything else, subcommand first. Quotes removed. */
  args: string[];
  /** `tool args…` — the canonical form the gate's patterns match. */
  line: string;
  /** Why this invocation cannot be read confidently. Treat as risky. */
  unclear?: string;
}

export function vcsInvocations(command: string): VcsInvocation[] {
  return scan(command, 0);
}

/** Deep enough for `bash -c "echo \"$(git …)\""`; past it, refuse to guess. */
const MAX_DEPTH = 6;
/** Stands in for a `$(…)` / backtick in the outer text: it is an expansion. */
const SUBST = "$__subst__";

function scan(command: string, depth: number): VcsInvocation[] {
  if (depth > MAX_DEPTH) {
    return /\b(git|gh|glab)\b/.test(command)
      ? [{ tool: "git", globals: [], args: [], line: "git …", unclear: "nested too deeply to read" }]
      : [];
  }
  const out: VcsInvocation[] = [];
  // Heredoc bodies first, as scripts of their own: `bash <<EOF` runs one, and a
  // stray apostrophe in a `cat <<EOF` commit message must not unbalance the
  // quoting of everything after it.
  const { text: withoutBodies, bodies: heredocs } = takeHeredocs(command);
  for (const body of heredocs) out.push(...scan(body, depth + 1));
  const { text, bodies } = takeSubstitutions(withoutBodies);
  const fromBodies = bodies.flatMap((body) => scan(body, depth + 1));
  out.push(...fromBodies);
  // `$(which git) push` — the substitution printed a binary's path.
  const chosen = fromBodies.find((i) => i.args.length === 0 && !i.unclear);

  for (const stage of splitStages(text)) {
    const words = stageWords(stage.text);
    const { at: commandAt, config } = commandIndex(words);
    const runs = commandAt >= 0 ? basename(words[commandAt] as string) : "";
    const lenient = LENIENT.has(runs);
    if (chosen && runs.includes(SUBST)) {
      const args = words.slice(commandAt + 1).map(cleanArg).filter((a) => a !== "");
      out.push({
        tool: chosen.tool, globals: [], args, line: [chosen.tool, ...args].join(" "),
        unclear: `the binary is chosen by a command substitution (${words[commandAt]})`,
      });
    }
    // A second tool name in one stage is an argument of the first
    // (`git diff gh -- x`): still read, never `unclear`.
    let parsedOne = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as string;
      // A quoted word with shell structure in it may be a script (`bash -c '…'`,
      // `eval "…"`, `ssh host '…'`) — read it as one.
      if (/[\s;&|<>(){}`]/.test(w)) out.push(...scan(w, depth + 1));
      const strict = !lenient && !parsedOne;
      const found = toolOf(w, strict);
      if (!found) continue;
      parsedOne = true;
      const { tool, dashed } = found;
      const rest = words.slice(i + 1).map(cleanArg).filter((a) => a !== "");
      const parsed: Omit<VcsInvocation, "tool" | "line"> = dashed
        ? { globals: [], args: [dashed, ...rest] }
        : tool === "git"
          ? parseGit(rest, strict)
          : parseForge(rest, strict);
      // `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p … git p` is an inline alias.
      if (strict && tool === "git" && i === commandAt && config && !parsed.unclear) {
        parsed.unclear = `${config} in front of git can redefine what it runs`;
      }
      // `echo push | xargs git -C .` — xargs appends the subcommand from stdin.
      const feeder = words.slice(0, i).map(basename).find((b) => b === "xargs" || b === "parallel");
      if (strict && !parsed.unclear && parsed.args.length === 0 && feeder) {
        parsed.unclear = `the subcommand comes from ${feeder}' input`;
      }
      out.push({ tool, ...parsed, line: [tool, ...parsed.args].join(" ") });
    }
  }
  return out;
}

// ── Locating the command ────────────────────────────────────────────────────

/** Words in front of a command that do not change which binary runs. */
const GROUPING = new Set(["(", "{", "!", "do", "then", "else", "time", "command", "exec", "builtin", "nohup"]);

/** Wrappers that take a command as argv, with the options that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  env: new Set(["-u", "--unset", "-C", "--chdir"]),
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]),
  nice: new Set(["-n"]),
  xargs: new Set(["-I", "-n", "-L", "-P", "-s", "-d", "-E", "-a"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  caffeinate: new Set(["-t", "-w"]),
};

/** Commands whose arguments are patterns, text or package names: a git / gh /
 *  glab among them is a mention, read leniently. Everything else is strict. */
const LENIENT = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "echo", "printf", "which", "type", "whereis",
  "man", "apropos", "pgrep", "brew", "port", "apt", "apt-get", "npm", "pnpm", "yarn", "pip", "pip3",
]);

/** Environment that hands git a config — and so an alias — or its own binaries. */
const GIT_CONFIG_ENV = /^(GIT_CONFIG\w*|GIT_EXEC_PATH)=/;

/** Index of the word a stage actually runs (-1 if none), and any git config
 *  smuggled in through the environment on the way to it. */
function commandIndex(words: string[]): { at: number; config?: string } {
  let config: string | undefined;
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || GROUPING.has(w)) {
      if (GIT_CONFIG_ENV.test(w)) config ??= w.slice(0, w.indexOf("="));
      i++;
      continue;
    }
    const valued = WRAPPERS[basename(w)];
    if (!valued) return config ? { at: i, config } : { at: i };
    i++;
    while (i < words.length && /^-|^\d+[smhd]?$/.test(words[i] as string)) {
      if (valued.has(words[i] as string)) i++;
      i++;
    }
  }
  return { at: -1 };
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** git / gh / glab by name or by a path to it (`/usr/bin/git`, `~/bin/gh`,
 *  `$HOME/bin/glab`). `\git` and `(git` are the same binary; `src/git` is a
 *  directory. In a strict read, git-core's dashed binaries count too:
 *  `/usr/libexec/git-core/git-push` is `git push`. */
function toolOf(word: string, dashedToo: boolean): { tool: VcsTool; dashed?: string } | null {
  const bare = word.replace(/\\/g, "").replace(/^[({!]+/, "");
  if (bare.includes("/") && !/^[/~.$]/.test(bare)) return null;
  const base = basename(bare);
  if (base === "git" || base === "gh" || base === "glab") return { tool: base };
  const dashed = dashedToo ? /^git-([a-z][a-z0-9-]*)$/.exec(base) : null;
  return dashed ? { tool: "git", dashed: dashed[1] as string } : null;
}

function cleanArg(word: string): string {
  let w = word.replace(/\\(.)/g, "$1");
  if (w.endsWith(")") && !w.includes("(")) w = w.replace(/\)+$/, "");
  if (w.endsWith("}") && !w.includes("{")) w = w.replace(/\}+$/, "");
  return w;
}

// ── git ─────────────────────────────────────────────────────────────────────

/** `git <opt> <value> <sub>` — git(1) "OPTIONS", the ones that take a value. */
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);
const GIT_ATTACHED_OPT = /^--(git-dir|work-tree|namespace|super-prefix|config-env|exec-path|attr-source|list-cmds)=/;
const GIT_FLAGS = new Set([
  "-p", "--paginate", "-P", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs",
  "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks",
  "--no-lazy-fetch", "--no-advice", "--exec-path", "--html-path", "--man-path", "--info-path",
]);
/** git reads these as the `version` / `help` command, not as options. */
const GIT_AS_COMMAND = new Set(["--version", "-v", "--help", "-h"]);

function parseGit(words: string[], strict: boolean): Omit<VcsInvocation, "tool" | "line"> {
  const globals: string[] = [];
  let unclear: string | undefined;
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i] as string;
    let config: string | undefined;
    if (GIT_VALUE_OPTS.has(w)) {
      const value = words[i + 1] ?? "";
      globals.push(w, value);
      i++;
      if (w === "-c" || w === "--config-env") config = value;
    } else if (GIT_ATTACHED_OPT.test(w)) {
      globals.push(w);
      if (w.startsWith("--config-env=")) config = w.slice("--config-env=".length);
    } else if (GIT_FLAGS.has(w)) {
      globals.push(w);
    } else {
      break;
    }
    // `alias.p=push` defines `git p`; `help.autocorrect` runs `git pus` as push.
    if (strict && !unclear && config !== undefined && /^(alias\.|help\.autocorrect)/i.test(config)) {
      unclear = `an inline alias (${w} ${config}) decides what this runs`;
    }
  }
  const args = words.slice(i);
  const sub = args[0];
  if (strict && !unclear && sub !== undefined) {
    if (sub.startsWith("-") && !GIT_AS_COMMAND.has(sub)) unclear = `unrecognised git option ${sub}`;
    else if (sub.includes("$")) unclear = `a shell expansion (${sub}) where the git subcommand should be`;
    else if (sub.includes("{}")) unclear = `the subcommand comes from input (${sub})`;
  }
  return unclear ? { globals, args, unclear } : { globals, args };
}

// ── gh / glab ───────────────────────────────────────────────────────────────

/** Help and version print and exit, wherever they sit. */
const FORGE_HARMLESS = new Set(["--help", "-h", "--version"]);
/** Top-level commands with no subcommand under them. */
const FORGE_LEAF = new Set(["api", "browse", "status", "version", "completion"]);

/**
 * gh and glab are cobra CLIs: flags may sit anywhere, including between `pr`
 * and `create`. `-R` / `--repo` only picks the repository and is dropped
 * wherever it is; any OTHER option before the command is resolved is unclear,
 * because cobra cannot be second-guessed about whether it takes a value.
 */
function parseForge(words: string[], strict: boolean): Omit<VcsInvocation, "tool" | "line"> {
  const globals: string[] = [];
  const args: string[] = [];
  let unclear: string | undefined;
  let names = 0;
  let needed = 2;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "-R" || w === "--repo") {
      globals.push(w, words[i + 1] ?? "");
      i++;
      continue;
    }
    if (/^-R./.test(w) || w.startsWith("--repo=")) {
      globals.push(w);
      continue;
    }
    const resolving = names < needed;
    if (w.startsWith("-") && w.length > 1) {
      if (strict && resolving && !unclear && !FORGE_HARMLESS.has(w)) unclear = `unrecognised option ${w} before the command`;
      args.push(w);
      continue;
    }
    if (strict && resolving && !unclear && w.includes("$")) unclear = `a shell expansion (${w}) where the command should be`;
    names++;
    if (names === 1 && FORGE_LEAF.has(w)) needed = 1;
    args.push(w);
  }
  return unclear ? { globals, args, unclear } : { globals, args };
}

// ── Commands inside commands ────────────────────────────────────────────────

/** Remove heredoc bodies from the text and return them. The introducing line
 *  stays. `<<<` is a herestring, not a heredoc. */
function takeHeredocs(command: string): { text: string; bodies: string[] } {
  const out: string[] = [];
  const bodies: string[] = [];
  const pending: string[] = [];
  let body: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      if (line.replace(/^\t+/, "").trim() === pending[0]) {
        pending.shift();
        bodies.push(body.join("\n"));
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }
    out.push(line);
    const re = /(?<!<)<<-?(?!<)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) pending.push(m[2] as string);
  }
  // An unterminated heredoc runs to the end of the command; it is still read.
  if (body.length > 0) bodies.push(body.join("\n"));
  return { text: out.join("\n"), bodies };
}

/** Replace each `$(…)`, `<(…)`, `>(…)` and backtick span with a placeholder
 *  and return their bodies. Single-quoted text is literal. */
function takeSubstitutions(command: string): { text: string; bodies: string[] } {
  let text = "";
  const bodies: string[] = [];
  let single = false;
  let double = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (single) {
      text += c;
      if (c === "'") single = false;
      continue;
    }
    if (c === "\\") {
      text += c + (command[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'" && !double) {
      single = true;
      text += c;
      continue;
    }
    if (c === '"') {
      double = !double;
      text += c;
      continue;
    }
    if (command[i + 1] === "(" && (c === "$" || (!double && (c === "<" || c === ">")))) {
      const end = closingParen(command, i + 2);
      bodies.push(command.slice(i + 2, end));
      text += SUBST;
      i = end;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      while (j < command.length && command[j] !== "`") j += command[j] === "\\" ? 2 : 1;
      bodies.push(command.slice(i + 1, j));
      text += SUBST;
      i = j;
      continue;
    }
    text += c;
  }
  return { text, bodies };
}

/** Index of the `)` closing a `(` opened just before `from`; the end of the
 *  string when unbalanced (the rest is then read as the body). */
function closingParen(s: string, from: number): number {
  let depth = 1;
  let single = false;
  let double = false;
  for (let j = from; j < s.length; j++) {
    const c = s[j] as string;
    if (single) {
      if (c === "'") single = false;
      continue;
    }
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === "'" && !double) single = true;
    else if (c === '"') double = !double;
    else if (!double && c === "(") depth++;
    else if (!double && c === ")" && --depth === 0) return j;
  }
  return s.length;
}
