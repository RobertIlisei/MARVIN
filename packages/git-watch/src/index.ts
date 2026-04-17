/**
 * Git watch — detect new commits on the active project repo between calls.
 *
 * MARVIN uses this to surface "you just committed X" inline in the chat
 * without having to ask you. No board, no task auto-posting, no agent-to-task
 * attribution — that complexity belonged to J.A.R.V.I.S.
 *
 * The watchdog is **stateless** across sessions: it keeps a cursor in-memory
 * per workDir (last-seen HEAD) and returns the commits that landed since.
 * First call for a workDir returns `[]` and anchors at HEAD.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const pExecFile = promisify(execFile);

export interface Commit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  subject: string;
  relativeDate: string;
}

const lastSeenByWorkDir = new Map<string, string>();

async function gitHead(workDir: string): Promise<string | null> {
  try {
    const { stdout } = await pExecFile("git", ["-C", workDir, "rev-parse", "HEAD"], {
      timeout: 4000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function listCommitsSince(workDir: string, from: string): Promise<Commit[]> {
  try {
    const { stdout } = await pExecFile(
      "git",
      [
        "-C",
        workDir,
        "log",
        `${from}..HEAD`,
        "--pretty=format:%H%x09%an%x09%ae%x09%ar%x09%s",
      ],
      { maxBuffer: 2 * 1024 * 1024, timeout: 8000 },
    );
    if (!stdout.trim()) return [];
    const out: Commit[] = [];
    for (const line of stdout.split("\n")) {
      const parts = line.split("\t");
      if (parts.length < 5) continue;
      const sha = parts[0];
      const author = parts[1];
      const email = parts[2];
      const relativeDate = parts[3];
      if (!sha || !author || !email || !relativeDate) continue;
      out.push({
        sha,
        shortSha: sha.slice(0, 7),
        author,
        email,
        relativeDate,
        subject: parts.slice(4).join("\t"),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Returns new commits since the last call for this workDir. First call
 * anchors at HEAD and returns `[]`.
 */
export async function detectNewCommits(workDir: string): Promise<Commit[]> {
  const prior = lastSeenByWorkDir.get(workDir);
  if (!prior) {
    const head = await gitHead(workDir);
    if (head) lastSeenByWorkDir.set(workDir, head);
    return [];
  }
  const commits = await listCommitsSince(workDir, prior);
  const head = await gitHead(workDir);
  if (head) lastSeenByWorkDir.set(workDir, head);
  return commits;
}

/** Drop the cursor for a workDir (e.g. when switching projects). */
export function resetCommitCursor(workDir: string): void {
  lastSeenByWorkDir.delete(workDir);
}

/** Convenience: get the current HEAD sha for a workDir. */
export async function getCurrentHead(workDir: string): Promise<string | null> {
  return gitHead(workDir);
}
