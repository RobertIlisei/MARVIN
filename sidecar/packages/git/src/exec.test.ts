import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runGit } from "./exec";

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "marvin-exec-"));
  execFileSync("git", ["init", "-q", dir]);
  return dir;
}

/** Hold the event loop synchronously — what `execFileSync` in another route does. */
function blockLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe("runGit — a late timer is not a git timeout", () => {
  it("survives an event loop blocked for longer than its own timeout", async () => {
    // 2026-09-10: `/api/worktrees` reconciles every tree with execFileSync
    // and held the loop ~1.5 s; the status probe (2 s timer) reported a
    // 60 ms `rev-parse` as a timeout, and the panel rendered
    // "(not a git repository)" on a healthy repo.
    const dir = tempRepo();
    const pending = runGit(dir, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 200 });
    blockLoop(700);
    const res = await pending;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.stdout.trim()).toBe("true");
  });

  it("still reports a real hang as a timeout", async () => {
    // An editor that sleeps holds `git commit` open for longer than the
    // timer; nothing blocks the loop, so the timer is trusted and kills.
    const dir = tempRepo();
    const res = await runGit(dir, ["commit", "--allow-empty"], {
      timeoutMs: 300,
      env: { ...process.env, GIT_EDITOR: "sh -c 'sleep 5'", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("timeout");
  });

  it("answers exit 128 as non-zero-exit, which is what a non-repo looks like", async () => {
    const dir = mkdtempSync(join(tmpdir(), "marvin-exec-plain-"));
    const res = await runGit(dir, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("non-zero-exit");
  });
});
