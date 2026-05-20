/**
 * Auto-mode audit log.
 *
 * Audit finding #2 (deferred half): when MARVIN runs in `auto`
 * permission mode, every Edit / Write / Bash that would have rendered
 * a confirm card in `gated` mode runs without a prompt. The
 * `BASH_HARD_DENY` regex set is the only floor. There's no record of
 * what auto-allowed actions actually fired.
 *
 * This module appends one JSON-line per auto-allowed mutation to
 * `<workDir>/.marvin/auto-audit.jsonl`. The Settings panel reads the
 * tail of that file to surface a "recent auto-allows" list so users
 * can audit MARVIN's behaviour after the fact.
 *
 * Designed to be **always-cheap and never-throwing**. A failure here
 * must not block the SDK loop. Worst case: the line is dropped, the
 * turn proceeds.
 *
 * Scope: only mutating tools count. We skip Read / Grep / Glob /
 * WebFetch / WebSearch (read-only — no audit value) and the Task /
 * NotebookEdit / non-known tools (handled separately by the policy
 * gate). Bash is included even when its specific command is in the
 * `BASH_AUTO_ALLOW` whitelist — those are usually `git status`-class
 * reads, but we still log them for completeness.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export type AutoAuditEntryKind =
  | "Edit"
  | "Write"
  | "Bash"
  | "Read"
  | "Grep"
  | "Glob"
  | "WebFetch"
  | "WebSearch"
  | "Task"
  | "NotebookEdit";

export interface AutoAuditEntry {
  /** ISO-8601 timestamp. */
  at: string;
  /** Tool name as the SDK reported it. */
  tool: AutoAuditEntryKind;
  /** Why the gate auto-allowed (regex match label, "read-only", etc). */
  reason: string;
  /** A short, redacted descriptor for display — e.g. `rm -rf foo` truncated. */
  descriptor: string;
  /** Turn id (so the user can correlate to the chat transcript). */
  turnId: string;
  /** SDK tool-use id. */
  toolUseId: string;
}

const TOOLS_WORTH_LOGGING: ReadonlySet<AutoAuditEntryKind> = new Set([
  // Mutators — the user's primary risk surface.
  "Edit",
  "Write",
  "Bash",
  // NotebookEdit + Task fall through the gate via the policy module
  // and don't reach the bypass branch we hook below; logging them
  // would be redundant.
]);

/**
 * Best-effort one-line short descriptor for a tool call. Truncated to
 * 200 chars so a misbehaving prompt can't write multi-MB lines into
 * the log. Never throws.
 */
function describe(tool: AutoAuditEntryKind, input: Record<string, unknown>): string {
  try {
    if (tool === "Bash") {
      const cmd = String(input.command ?? "").slice(0, 200);
      return cmd;
    }
    if (tool === "Edit" || tool === "Write") {
      return String(input.file_path ?? input.path ?? "").slice(0, 200);
    }
    return JSON.stringify(input).slice(0, 200);
  } catch {
    return "<unstringifiable>";
  }
}

function auditFilePath(workDir: string): string {
  return path.join(workDir, ".marvin", "auto-audit.jsonl");
}

/**
 * Append an entry. Returns silently on any failure — the caller MUST
 * NOT depend on this for correctness.
 */
/**
 * Rotate threshold (bytes). When the active file exceeds this size on
 * write, rename it to `auto-audit.<ISO>.jsonl` and start a fresh
 * file. 5 MB is roughly 50k entries on a busy session — well past
 * "anything anyone would page through" but small enough to not bloat
 * the project dir. Audit 🟠 #6.
 */
const ROTATE_AT_BYTES = 5 * 1024 * 1024;

/**
 * How many rotated files to keep. The active file is always present;
 * we keep this many archives. Audit 🟠 #6.
 */
const KEEP_ARCHIVES = 4;

function listArchives(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith("auto-audit.") && n.endsWith(".jsonl"))
      .filter((n) => n !== "auto-audit.jsonl") // active file isn't an archive
      .sort();
  } catch {
    return [];
  }
}

/**
 * If the active log is past the size threshold, rename it to a
 * timestamped archive and prune older archives down to KEEP_ARCHIVES.
 * Best-effort — failure leaves the active file in place and we
 * continue appending to it. Worst case: the file grows past the
 * threshold for a while.
 */
function rotateIfNeeded(dir: string, activePath: string): void {
  try {
    const st = statSync(activePath);
    if (st.size < ROTATE_AT_BYTES) return;
  } catch {
    // No active file → nothing to rotate.
    return;
  }
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = path.join(dir, `auto-audit.${stamp}.jsonl`);
    renameSync(activePath, archivePath);
    // Prune oldest archives beyond the keep cap.
    const archives = listArchives(dir);
    const overflow = archives.length - KEEP_ARCHIVES;
    for (let i = 0; i < overflow; i += 1) {
      const name = archives[i];
      if (!name) continue;
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal — caller will keep appending to the old file */
  }
}

/**
 * Atomic-ish append. `appendFileSync` opens-writes-closes in one
 * syscall internally on POSIX, but a process crash between the
 * write and the fsync leaves no guarantee the line landed durably.
 * For the audit log (where partial lines would corrupt
 * `readAutoAuditTail`) we open with O_APPEND + write + fsync + close
 * so concurrent appends from sibling sidecar instances on the same
 * project can't interleave, and a hard crash mid-fsync at worst
 * loses the last entry (never produces a partial one).
 *
 * Audit 🟡 #15.
 */
function atomicAppendLine(filePath: string, line: string): void {
  // O_APPEND | O_WRONLY | O_CREAT, mode 0600 — multi-user readability
  // was raised in the parent audit (🟡 #12); the active log inherits
  // the same tightening.
  const fd = openSync(filePath, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendAutoAuditEntry(
  workDir: string,
  args: {
    tool: AutoAuditEntryKind;
    reason: string;
    input: Record<string, unknown>;
    turnId: string;
    toolUseId: string;
  },
): void {
  if (!TOOLS_WORTH_LOGGING.has(args.tool)) return;
  try {
    const dir = path.join(workDir, ".marvin");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* non-fatal */
      }
    }
    const activePath = auditFilePath(workDir);
    rotateIfNeeded(dir, activePath);
    const entry: AutoAuditEntry = {
      at: new Date().toISOString(),
      tool: args.tool,
      reason: args.reason,
      descriptor: describe(args.tool, args.input),
      turnId: args.turnId,
      toolUseId: args.toolUseId,
    };
    atomicAppendLine(activePath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* swallow — log writes must never block the SDK turn */
  }
}

/**
 * Read the last `limit` audit entries (newest last). Used by the
 * Settings UI to surface "recent auto-allows". Returns `[]` when the
 * file doesn't exist or isn't readable. Newest-first ordering is
 * applied by the caller — keep this function order-preserving (file
 * order = chronological).
 */
export function readAutoAuditTail(workDir: string, limit = 50): AutoAuditEntry[] {
  try {
    const p = auditFilePath(workDir);
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit);
    const out: AutoAuditEntry[] = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as AutoAuditEntry;
        out.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}
