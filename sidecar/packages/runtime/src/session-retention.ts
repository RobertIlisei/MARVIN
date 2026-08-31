/**
 * Session retention — age out old transcripts by compressing them (ADR-0074).
 *
 * Transcripts are append-only JSONL and they accumulate forever. Measured on a
 * real machine: **397 files / 3.04 GB**, of which **357 files / 2.82 GB (93 %)**
 * were older than a week. That is the disk cost of never forgetting.
 *
 * The obvious implementation — delete anything older than N days — was
 * deliberately NOT built. A transcript is the only record of what MARVIN did
 * in a session; ADR-0072 exists because a *display* bug that merely looked
 * like losing them was alarming enough. So retention **compresses** instead:
 *
 *   `<data>/sessions/<projectId>/<id>.jsonl`
 *     → `<data>/sessions-archive/<projectId>/<id>.jsonl.gz`
 *
 * JSONL of this shape compresses roughly 10-20x, so nearly all the disk comes
 * back while every byte remains recoverable with `gunzip` — or with
 * `restoreArchivedSession` below. "Cleanup" here means "out of the way", not
 * "gone".
 *
 * Three exemptions, in priority order:
 *
 *  1. **A live turn.** Never touch a session the SDK is mid-turn on, at any
 *     age. Archiving a file being appended to would corrupt it.
 *  2. **The N most recent per project.** Without a floor, a project untouched
 *     for a month opens with zero history — the exact "all my sessions are
 *     gone" experience, this time for real. The floor is per-project because
 *     activity is per-project.
 *  3. **Anything that fails verification.** The original is unlinked only
 *     after the archive is decompressed and byte-length-checked. A failed
 *     round-trip leaves the source untouched.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { marvinPaths } from "./paths";
import { getLiveTurn } from "./turn-registry";

/** Default age past which a transcript is archived. */
export const DEFAULT_RETENTION_DAYS = 7;
/** Default per-project floor — kept regardless of age. */
export const DEFAULT_KEEP_RECENT = 20;

export interface RetentionOptions {
  maxAgeDays?: number;
  keepRecent?: number;
  /** Report what would happen, touch nothing. */
  dryRun?: boolean;
  /** Restrict to one project. Omit to sweep every project. */
  projectId?: string;
  /** Injectable clock so tests don't depend on wall time. */
  now?: number;
}

export interface ArchivedSession {
  projectId: string;
  sessionId: string;
  bytes: number;
  archivedBytes: number;
}

export interface RetentionResult {
  archived: ArchivedSession[];
  /** Sessions considered but exempt, with the reason. */
  skipped: Array<{ projectId: string; sessionId: string; reason: string }>;
  /** Sessions whose archive failed verification — originals left in place. */
  failed: Array<{ projectId: string; sessionId: string; error: string }>;
  bytesBefore: number;
  bytesAfter: number;
  dryRun: boolean;
}

/** `<data>/sessions-archive/<projectId>/`. */
export function archiveDir(projectId: string): string {
  return join(marvinPaths.dataDir(), "sessions-archive", projectId);
}

function sessionsRoot(): string {
  return join(marvinPaths.dataDir(), "sessions");
}

/** Every project id that has a sessions directory. */
function listProjectDirs(): string[] {
  try {
    return readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

interface Candidate {
  sessionId: string;
  path: string;
  mtimeMs: number;
  bytes: number;
}

function listCandidates(projectId: string): Candidate[] {
  const dir = join(sessionsRoot(), projectId);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      out.push({
        sessionId: name.replace(/\.jsonl$/, ""),
        path,
        mtimeMs: st.mtimeMs,
        bytes: st.size,
      });
    } catch {
      /* vanished mid-scan — skip */
    }
  }
  // Newest first: the keep-recent floor is "the first N of this list".
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Compress one transcript into the archive and remove the original.
 *
 * The unlink happens ONLY after the written archive is read back,
 * decompressed, and confirmed byte-identical in length to the source. A
 * cleanup routine that deletes on the strength of "the write didn't throw" is
 * how archives turn out to be empty six months later.
 */
function archiveOne(
  projectId: string,
  c: Candidate,
): { archivedBytes: number } | { error: string } {
  const destDir = archiveDir(projectId);
  const dest = join(destDir, `${c.sessionId}.jsonl.gz`);
  try {
    const source = readFileSync(c.path);
    const packed = gzipSync(source, { level: 9 });
    mkdirSync(destDir, { recursive: true });
    writeFileSync(dest, packed);

    const verify = gunzipSync(readFileSync(dest));
    if (verify.length !== source.length) {
      rmSync(dest, { force: true });
      return {
        error: `archive verify failed (${verify.length} != ${source.length} bytes)`,
      };
    }

    rmSync(c.path, { force: true });

    // The companion plan file rides along — it is meaningless without its
    // transcript, and leaving it behind would strand it forever.
    const plans = c.path.replace(/\.jsonl$/, ".plans.json");
    if (existsSync(plans)) {
      try {
        writeFileSync(join(destDir, `${c.sessionId}.plans.json`), readFileSync(plans));
        rmSync(plans, { force: true });
      } catch {
        /* the transcript is safe; a stranded plan file is not worth failing on */
      }
    }
    return { archivedBytes: packed.length };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sweep one project (or all) and archive anything past the age cut.
 *
 * Never throws — retention is a background courtesy and must not be able to
 * take down the process that calls it.
 */
export function archiveOldSessions(opts: RetentionOptions = {}): RetentionResult {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_RETENTION_DAYS;
  const keepRecent = Math.max(0, opts.keepRecent ?? DEFAULT_KEEP_RECENT);
  const now = opts.now ?? Date.now();
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const dryRun = opts.dryRun === true;

  const result: RetentionResult = {
    archived: [],
    skipped: [],
    failed: [],
    bytesBefore: 0,
    bytesAfter: 0,
    dryRun,
  };

  const projects = opts.projectId ? [opts.projectId] : listProjectDirs();
  for (const projectId of projects) {
    const candidates = listCandidates(projectId);
    candidates.forEach((c, index) => {
      result.bytesBefore += c.bytes;

      // Exemption 2 — the per-project floor. Checked first because it is the
      // cheapest and the most likely to apply.
      if (index < keepRecent) {
        result.skipped.push({ projectId, sessionId: c.sessionId, reason: "within keep-recent" });
        result.bytesAfter += c.bytes;
        return;
      }
      if (c.mtimeMs >= cutoff) {
        result.skipped.push({ projectId, sessionId: c.sessionId, reason: "newer than cutoff" });
        result.bytesAfter += c.bytes;
        return;
      }
      // Exemption 1 — a turn is in flight against this transcript.
      if (getLiveTurn(c.sessionId)) {
        result.skipped.push({ projectId, sessionId: c.sessionId, reason: "live turn" });
        result.bytesAfter += c.bytes;
        return;
      }

      if (dryRun) {
        result.archived.push({
          projectId,
          sessionId: c.sessionId,
          bytes: c.bytes,
          archivedBytes: 0,
        });
        return;
      }

      const outcome = archiveOne(projectId, c);
      if ("error" in outcome) {
        result.failed.push({ projectId, sessionId: c.sessionId, error: outcome.error });
        result.bytesAfter += c.bytes;
        return;
      }
      result.archived.push({
        projectId,
        sessionId: c.sessionId,
        bytes: c.bytes,
        archivedBytes: outcome.archivedBytes,
      });
      result.bytesAfter += outcome.archivedBytes;
    });

    // The ADR-0072 summary cache indexes live transcripts by id. Entries for
    // archived sessions would otherwise linger and list sessions that are no
    // longer there.
    if (!dryRun) dropSummaryCacheEntries(projectId, result.archived.map((a) => a.sessionId));
  }

  return result;
}

/** Remove archived ids from the picker's summary cache (ADR-0072). */
function dropSummaryCacheEntries(projectId: string, archivedIds: string[]): void {
  if (archivedIds.length === 0) return;
  const p = join(sessionsRoot(), projectId, ".summaries.json");
  try {
    const cache = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
    let changed = false;
    for (const id of archivedIds) {
      if (id in cache) {
        delete cache[id];
        changed = true;
      }
    }
    if (changed) writeFileSync(p, JSON.stringify(cache), "utf-8");
  } catch {
    /* no cache yet, or unreadable — the next list rebuilds it */
  }
}

/** Archived session ids for a project, newest-first by archive mtime. */
export function listArchivedSessions(projectId: string): Array<{
  sessionId: string;
  archivedAt: string;
  bytes: number;
}> {
  const dir = archiveDir(projectId);
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl.gz"))
      .map((n) => {
        const st = statSync(join(dir, n));
        return {
          sessionId: n.replace(/\.jsonl\.gz$/, ""),
          archivedAt: new Date(st.mtimeMs).toISOString(),
          bytes: st.size,
          mtime: st.mtimeMs,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map(({ sessionId, archivedAt, bytes }) => ({ sessionId, archivedAt, bytes }));
  } catch {
    return [];
  }
}

/**
 * Bring an archived transcript back into the live sessions directory.
 *
 * This is what makes the archive an archive rather than a delete: the round
 * trip is supported and tested, not just theoretically possible with `gunzip`.
 * Refuses to clobber a live transcript of the same id.
 */
export function restoreArchivedSession(
  projectId: string,
  sessionId: string,
): { ok: boolean; error?: string; path?: string } {
  const src = join(archiveDir(projectId), `${sessionId}.jsonl.gz`);
  if (!existsSync(src)) return { ok: false, error: "no archived session with that id." };
  const dest = marvinPaths.sessionFile(projectId, sessionId);
  if (existsSync(dest)) {
    return { ok: false, error: "a live session with that id already exists." };
  }
  try {
    const unpacked = gunzipSync(readFileSync(src));
    mkdirSync(join(sessionsRoot(), projectId), { recursive: true });
    writeFileSync(dest, unpacked);
    const plans = join(archiveDir(projectId), `${sessionId}.plans.json`);
    if (existsSync(plans)) {
      writeFileSync(dest.replace(/\.jsonl$/, ".plans.json"), readFileSync(plans));
    }
    // Leave the archive copy in place: a restore that destroys the archive
    // turns a recoverable mistake into an unrecoverable one.
    return { ok: true, path: dest };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
