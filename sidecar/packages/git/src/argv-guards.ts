/**
 * Regex whitelists for user-supplied values that travel into `git` argv.
 *
 * MARVIN's git routes accept refs, paths, and remote names from the UI.
 * Even though every `git` invocation goes through `runGit` (which uses
 * `execFile` with `shell: false`), a malicious ref name like
 * `--upload-pack=/bin/sh` would still be parsed by `git` as a flag.
 * Every user-supplied string that becomes an argv element passes
 * through one of these guards before it gets near `runGit`.
 *
 * See [ADR-0012](../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

/**
 * Conservative ref-name regex. `git check-ref-format` allows a richer
 * character class (including unicode in recent versions), but we don't
 * need any of it for branch / tag names typed into the UI. Restricting
 * the set keeps the rejection easy to reason about.
 *
 * Allowed: letters, digits, `.`, `_`, `/`, `-`. Length 1..250.
 * Rejected: leading `-` (would be parsed as a flag), leading `.`, `..`
 * anywhere, trailing `/`, `@{` (reflog syntax), whitespace, NUL,
 * backslash, any shell metacharacter.
 */
const REF_CHAR = /^[A-Za-z0-9._/-]+$/;

export function isSafeRef(name: string): boolean {
  if (!name || name.length > 250) return false;
  if (!REF_CHAR.test(name)) return false;
  if (name.startsWith("-")) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.endsWith("/") || name.endsWith(".lock")) return false;
  if (name.includes("..")) return false;
  if (name.includes("@{")) return false;
  if (name.includes("//")) return false;
  return true;
}

/**
 * Pathspec guard for `git add`, `git restore`, etc. Prevents the argv
 * element from being parsed as a flag; the sandbox check upstream is
 * responsible for actually anchoring the path inside the project cwd.
 *
 * Callers should prefix pathspecs with `--` in argv as defence in
 * depth, but `git` does not consistently honour `--` for all
 * subcommands — so we reject leading `-` here too.
 */
export function isSafePathspec(p: string): boolean {
  if (!p || p.length > 1024) return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("-")) return false;
  // Pathspec magic prefixes `:(`, `:!`, `:/` — we never emit these, so
  // reject them coming in.
  if (p.startsWith(":")) return false;
  return true;
}

/**
 * Remote-name guard for `git push`, `git pull`, `git fetch`. Git allows
 * some punctuation in remote names but real-world remotes are plain
 * alphanumerics with optional dashes / dots.
 */
export function isSafeRemote(name: string): boolean {
  if (!name || name.length > 100) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  return true;
}

/**
 * Commit message guard. Messages travel via stdin (`git commit -F -`),
 * not argv, so the risk surface is narrower — but we still reject NUL
 * bytes (which would truncate the message) and cap length to prevent
 * accidental megabyte-scale messages from a broken client.
 */
export function isSafeCommitMessage(msg: string): boolean {
  if (!msg || msg.trim().length === 0) return false;
  if (msg.length > 16_384) return false;
  if (msg.includes("\0")) return false;
  return true;
}

/**
 * Flags that `runGit` MUST reject in caller-supplied argv. Each one is
 * an RCE or sandbox-escape vector:
 *
 * - `-c <alias>=!…` — arbitrary command via git alias
 * - `-C <path>` — changes git's working directory, bypasses our sandbox
 * - `--exec-path=…` — points git at an attacker-controlled core.*
 * - `--git-dir=…`, `--work-tree=…` — bypass the sandbox
 * - `--upload-pack=…`, `--receive-pack=…` — RCE on clone/fetch/push
 * - `--config-env=…` — same surface as -c
 */
const FORBIDDEN_FLAG_PREFIXES: readonly string[] = [
  "-c",
  "-C",
  "--exec-path",
  "--git-dir",
  "--work-tree",
  "--upload-pack",
  "--receive-pack",
  "--config-env",
  "--super-prefix",
];

export function containsForbiddenFlag(argv: readonly string[]): string | null {
  for (const arg of argv) {
    for (const bad of FORBIDDEN_FLAG_PREFIXES) {
      if (arg === bad) return bad;
      if (arg.startsWith(`${bad}=`)) return bad;
    }
  }
  return null;
}
