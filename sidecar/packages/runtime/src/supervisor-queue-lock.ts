/**
 * One opener per project (ADR-0133 §2): a lock file in the data dir that
 * records its holder's pid.
 *
 * The incident behind it: a second dispatcher process, started by hand a day
 * earlier, opened six tabs past the cap. Here a second process on the same
 * data dir cannot take the lock, so it opens nothing; a lock whose pid is gone
 * is cleared at boot.
 *
 * The same mechanism, with its own file, is the standing merge pass's lock
 * (ADR-0134 invariant 9): `queue.lock` and `merge.lock` are independent.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensureSupervisorDir, isSafeProjectId, supervisorDir, supervisorRoot } from "./supervisor-ledger";

export function queueLockPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "queue.lock");
}

export function mergeLockPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "merge.lock");
}

export const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

function holderOf(file: string): number {
  try {
    return Number((JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid);
  } catch {
    return 0; // unreadable: stale
  }
}

type Who = { pid: number; isAlive?: (pid: number) => boolean };

/**
 * Take the lock at `file`, or learn that another live process holds it. A lock
 * that records a dead pid — or OUR pid from an earlier life — is cleared and taken.
 */
function acquireLock(projectId: string, file: string, who: Who): "ours" | "held" {
  const alive = who.isAlive ?? isPidAlive;
  ensureSupervisorDir(projectId);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, `${JSON.stringify({ pid: who.pid, at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      return "ours";
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return "held";
    }
    const holder = holderOf(file);
    if (holder === who.pid) return "ours";
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) return "held";
    try {
      unlinkSync(file);
    } catch {
      return "held";
    }
  }
  return "held";
}

/** Boot: clear every `name` lock whose pid is gone, or is this process's own from an earlier life. Returns the projects cleared. */
function clearStaleLocks(name: string, isAlive: (pid: number) => boolean, selfPid: number): string[] {
  const root = supervisorRoot();
  const cleared: string[] = [];
  if (!existsSync(root)) return cleared;
  for (const project of readdirSync(root)) {
    if (!isSafeProjectId(project)) continue;
    const file = path.join(root, project, name);
    if (!existsSync(file)) continue;
    const holder = holderOf(file);
    if (holder !== selfPid && Number.isInteger(holder) && holder > 0 && isAlive(holder)) continue;
    try {
      unlinkSync(file);
      cleared.push(project);
    } catch {
      /* left for the next boot */
    }
  }
  return cleared;
}

/** Take the project's opener lock. The lock is held for the process's lifetime. */
export function acquireQueueLock(projectId: string, who: Who = { pid: process.pid }): "ours" | "held" {
  return acquireLock(projectId, queueLockPath(projectId), who);
}

/** Boot: clear every opener lock whose pid is gone. Returns the projects cleared. */
export function clearStaleQueueLocks(isAlive: (pid: number) => boolean = isPidAlive, selfPid = process.pid): string[] {
  return clearStaleLocks("queue.lock", isAlive, selfPid);
}

/** ADR-0134 invariant 9 — one merge pass per project at a time, across processes. Held for the pass, released when it ends. */
export function acquireMergeLock(projectId: string, who: Who = { pid: process.pid }): "ours" | "held" {
  return acquireLock(projectId, mergeLockPath(projectId), who);
}

/** Release the merge lock — only if this pid holds it. */
export function releaseMergeLock(projectId: string, pid = process.pid): void {
  const file = mergeLockPath(projectId);
  try {
    if (holderOf(file) === pid) unlinkSync(file);
  } catch {
    /* a lock that cannot be removed is cleared at the next boot or acquire, its pid being gone */
  }
}

/** Boot: clear every merge lock whose pid is gone. Returns the projects cleared. */
export function clearStaleMergeLocks(isAlive: (pid: number) => boolean = isPidAlive, selfPid = process.pid): string[] {
  return clearStaleLocks("merge.lock", isAlive, selfPid);
}
