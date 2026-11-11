/**
 * One opener per project (ADR-0133 §2): a lock file in the data dir that
 * records its holder's pid.
 *
 * The incident behind it: a second dispatcher process, started by hand a day
 * earlier, opened six tabs past the cap. Here a second process on the same
 * data dir cannot take the lock, so it opens nothing; a lock whose pid is gone
 * is cleared at boot.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensureSupervisorDir, isSafeProjectId, supervisorDir, supervisorRoot } from "./supervisor-ledger";

export function queueLockPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "queue.lock");
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

/**
 * Take the project's opener lock, or learn that another live process holds
 * it. The lock is held for the process's lifetime. A lock that records a dead
 * pid — or OUR pid from an earlier life — is cleared and taken.
 */
export function acquireQueueLock(projectId: string, who: { pid: number; isAlive?: (pid: number) => boolean } = { pid: process.pid }): "ours" | "held" {
  const alive = who.isAlive ?? isPidAlive;
  const file = queueLockPath(projectId);
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

/** Boot: clear every lock whose pid is gone, or is this process's own from an earlier life. Returns the projects cleared. */
export function clearStaleQueueLocks(isAlive: (pid: number) => boolean = isPidAlive, selfPid = process.pid): string[] {
  const root = supervisorRoot();
  const cleared: string[] = [];
  if (!existsSync(root)) return cleared;
  for (const name of readdirSync(root)) {
    if (!isSafeProjectId(name)) continue;
    const file = path.join(root, name, "queue.lock");
    if (!existsSync(file)) continue;
    const holder = holderOf(file);
    if (holder !== selfPid && Number.isInteger(holder) && holder > 0 && isAlive(holder)) continue;
    try {
      unlinkSync(file);
      cleared.push(name);
    } catch {
      /* left for the next boot */
    }
  }
  return cleared;
}
