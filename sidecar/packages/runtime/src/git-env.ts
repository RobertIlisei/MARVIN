/**
 * Git's "optional locks": a read such as `git status` takes `index.lock` to
 * write a refreshed index back. MARVIN runs those reads in a project's main
 * checkout for the session feed and the worktree lifecycle, and a merge,
 * commit or checkout that starts while one holds the lock is refused with
 * "fatal: Unable to write index." (2026-11-24, three times in a month on one
 * project, each read as a merge that had lost its state).
 *
 * `GIT_OPTIONAL_LOCKS=0` is git's own switch for a background process: reads
 * skip the write-back, writers are unaffected. Set once on the sidecar's
 * environment so every git child inherits it, including a turn's shell.
 * A value the user set wins.
 */
export function gitReadsTakeNoLock(env: NodeJS.ProcessEnv = process.env): void {
  env.GIT_OPTIONAL_LOCKS ??= "0";
}
