/**
 * Agent-edit checkpoints — the mechanism behind Cursor-style change review
 * (ADR-0034).
 *
 * The permission gate sees every agent `Edit` / `Write` / `NotebookEdit`
 * with its `file_path` BEFORE the write executes. `recordPreImage` snapshots
 * the file's pre-image the FIRST time a session touches it. From then on:
 *
 *   - changed set   = manifest entries whose baseline ≠ current disk
 *   - preview       = structured hunks of diff(baseline → disk)
 *   - reject hunk   = reverse-apply that hunk to the file on disk
 *   - accept hunk   = apply that hunk to the BASELINE (the baseline moves
 *                     forward, so a later "reject all" keeps accepted work)
 *   - reject file   = restore the baseline (delete the file if the baseline
 *                     is "did not exist")
 *   - accept file   = drop the entry (changes are already on disk)
 *
 * The baseline is the file's pre-FIRST-AGENT-TOUCH content — NOT git HEAD.
 * `git discard` reverts to HEAD, which is the wrong baseline whenever the
 * user had uncommitted edits before the agent touched the file.
 *
 * Store layout (per project + session, under the data dir):
 *   checkpoints/<projectId>/<marvinSessionId>/manifest.json
 *   checkpoints/<projectId>/<marvinSessionId>/blobs/<sha1-of-relpath>
 *
 * Known v1 limitation (documented in ADR-0034): mutations performed via
 * Bash (sed, codegen, git checkout, …) are not pre-imaged — the gate cannot
 * know a shell command's write targets up front. Cursor has the same
 * terminal blind spot.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { applyPatch, reversePatch, structuredPatch } from "diff";

import { marvinPaths } from "./paths";

// ── Types ──────────────────────────────────────────────────────────────

interface ManifestEntry {
  /** Repo-relative path (POSIX separators). */
  path: string;
  /** Blob filename holding the pre-image; null = file did not exist. */
  baselineBlob: string | null;
  /** Turn that first touched the file (attribution). */
  firstTurnId: string;
  /** ISO of the first touch. */
  firstTouchedAt: string;
  /** ISO of the most recent touch. */
  lastTouchedAt: string;
}

interface Manifest {
  cwd: string;
  files: Record<string, ManifestEntry>;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  firstTurnId: string;
  lastTouchedAt: string;
}

export interface DiffHunkLine {
  kind: "context" | "added" | "removed";
  text: string;
}

export interface DiffHunk {
  /** Stable index into the CURRENT recompute — hunk ops take this. */
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted";
  hunks: DiffHunk[];
}

export interface CheckpointKey {
  projectId: string;
  marvinSessionId: string;
}

// ── Manifest I/O ───────────────────────────────────────────────────────

function manifestPath(key: CheckpointKey): string {
  return join(
    marvinPaths.checkpointsDir(key.projectId, key.marvinSessionId),
    "manifest.json",
  );
}

function blobsDir(key: CheckpointKey): string {
  return join(
    marvinPaths.checkpointsDir(key.projectId, key.marvinSessionId),
    "blobs",
  );
}

function readManifest(key: CheckpointKey): Manifest | null {
  const p = manifestPath(key);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Manifest;
    if (!parsed || typeof parsed.cwd !== "string" || !parsed.files) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeManifest(key: CheckpointKey, m: Manifest): void {
  const p = manifestPath(key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m, null, 2), "utf-8");
}

function blobName(relPath: string): string {
  return createHash("sha1").update(relPath).digest("hex");
}

function readBaseline(key: CheckpointKey, e: ManifestEntry): string | null {
  if (e.baselineBlob === null) return null; // did not exist
  try {
    return readFileSync(join(blobsDir(key), e.baselineBlob), "utf-8");
  } catch {
    return null;
  }
}

function writeBaseline(key: CheckpointKey, relPath: string, content: string): string {
  const dir = blobsDir(key);
  mkdirSync(dir, { recursive: true });
  const name = blobName(relPath);
  writeFileSync(join(dir, name), content, "utf-8");
  return name;
}

/** Repo-relative POSIX path, or null when target escapes cwd. */
function relPathOf(cwd: string, absPath: string): string | null {
  const root = resolve(cwd);
  const target = resolve(absPath);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

function currentContent(cwd: string, relPath: string): string | null {
  const abs = join(cwd, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null; // unreadable (binary with invalid UTF-8 still decodes; perms issue)
  }
}

// ── Recording (called from the permission gate) ────────────────────────

/**
 * Snapshot the pre-image of `absPath` if this session hasn't touched it
 * yet. Best-effort and synchronous — called from the tool gate just
 * before an agent write executes; a failure here must never block the
 * write, so callers wrap in try/catch.
 */
export function recordPreImage(args: {
  key: CheckpointKey;
  cwd: string;
  turnId: string;
  absPath: string;
}): void {
  const rel = relPathOf(args.cwd, args.absPath);
  if (!rel) return; // outside the workspace — the fs sandbox governs that
  const manifest = readManifest(args.key) ?? { cwd: resolve(args.cwd), files: {} };
  const existing = manifest.files[rel];
  const now = new Date().toISOString();
  if (existing) {
    existing.lastTouchedAt = now;
    writeManifest(args.key, manifest);
    return; // baseline already captured — first touch wins
  }
  const abs = join(args.cwd, rel);
  let baselineBlob: string | null = null;
  if (existsSync(abs)) {
    baselineBlob = writeBaseline(args.key, rel, readFileSync(abs, "utf-8"));
  }
  manifest.files[rel] = {
    path: rel,
    baselineBlob,
    firstTurnId: args.turnId,
    firstTouchedAt: now,
    lastTouchedAt: now,
  };
  writeManifest(args.key, manifest);
}

// ── Reading ────────────────────────────────────────────────────────────

function statusOf(baseline: string | null, current: string | null): "added" | "modified" | "deleted" | "unchanged" {
  if (baseline === null && current === null) return "unchanged"; // never materialised
  if (baseline === null) return "added";
  if (current === null) return "deleted";
  if (baseline === current) return "unchanged";
  return "modified";
}

function hunksOf(relPath: string, baseline: string | null, current: string | null): DiffHunk[] {
  const patch = structuredPatch(
    relPath,
    relPath,
    baseline ?? "",
    current ?? "",
    "",
    "",
    { context: 3 },
  );
  return patch.hunks.map((h, i) => ({
    index: i,
    header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines.map((l): DiffHunkLine => ({
      kind: l.startsWith("+") ? "added" : l.startsWith("-") ? "removed" : "context",
      text: l.slice(1),
    })),
  }));
}

/**
 * The session's current changed set. Entries whose baseline equals the
 * disk content (e.g. the agent reverted its own edit, or every hunk was
 * rejected) are garbage-collected on read.
 */
export function listChanges(key: CheckpointKey): ChangedFile[] {
  const manifest = readManifest(key);
  if (!manifest) return [];
  const out: ChangedFile[] = [];
  let dirty = false;
  for (const [rel, entry] of Object.entries(manifest.files)) {
    const baseline = readBaseline(key, entry);
    const current = currentContent(manifest.cwd, rel);
    const status = statusOf(baseline, current);
    if (status === "unchanged") {
      dropEntry(key, manifest, rel);
      dirty = true;
      continue;
    }
    let additions = 0;
    let deletions = 0;
    for (const h of hunksOf(rel, baseline, current)) {
      for (const l of h.lines) {
        if (l.kind === "added") additions += 1;
        else if (l.kind === "removed") deletions += 1;
      }
    }
    out.push({
      path: rel,
      status,
      additions,
      deletions,
      firstTurnId: entry.firstTurnId,
      lastTouchedAt: entry.lastTouchedAt,
    });
  }
  if (dirty) writeManifest(key, manifest);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Structured hunks for one changed file (baseline → disk). */
export function diffFile(key: CheckpointKey, relPath: string): FileDiff | null {
  const manifest = readManifest(key);
  const entry = manifest?.files[relPath];
  if (!manifest || !entry) return null;
  const baseline = readBaseline(key, entry);
  const current = currentContent(manifest.cwd, relPath);
  const status = statusOf(baseline, current);
  if (status === "unchanged") return null;
  return { path: relPath, status, hunks: hunksOf(relPath, baseline, current) };
}

// ── Accept / Reject ────────────────────────────────────────────────────

function dropEntry(key: CheckpointKey, manifest: Manifest, relPath: string): void {
  const entry = manifest.files[relPath];
  if (!entry) return;
  if (entry.baselineBlob) {
    try {
      unlinkSync(join(blobsDir(key), entry.baselineBlob));
    } catch {
      /* blob already gone */
    }
  }
  delete manifest.files[relPath];
}

/** Accept a whole file: keep what's on disk, forget the baseline. */
export function acceptFile(key: CheckpointKey, relPath: string): boolean {
  const manifest = readManifest(key);
  if (!manifest || !manifest.files[relPath]) return false;
  dropEntry(key, manifest, relPath);
  writeManifest(key, manifest);
  return true;
}

/** Reject a whole file: restore the baseline (or delete an added file). */
export function rejectFile(key: CheckpointKey, relPath: string): boolean {
  const manifest = readManifest(key);
  const entry = manifest?.files[relPath];
  if (!manifest || !entry) return false;
  const baseline = readBaseline(key, entry);
  const abs = join(manifest.cwd, relPath);
  if (baseline === null) {
    // File did not exist before the agent created it.
    try {
      unlinkSync(abs);
    } catch {
      /* already gone */
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, baseline, "utf-8");
  }
  dropEntry(key, manifest, relPath);
  writeManifest(key, manifest);
  return true;
}

/**
 * Build a single-hunk patch object jsdiff can apply. Hunk indices refer
 * to the CURRENT recompute of diff(baseline → disk) — the caller fetched
 * them via {@link diffFile} moments ago; we recompute here so a stale
 * index can only miss (return false), never corrupt.
 */
function singleHunkPatch(relPath: string, baseline: string | null, current: string | null, hunkIndex: number) {
  const patch = structuredPatch(relPath, relPath, baseline ?? "", current ?? "", "", "", { context: 3 });
  const hunk = patch.hunks[hunkIndex];
  if (!hunk) return null;
  return { ...patch, hunks: [hunk] };
}

/**
 * Accept one hunk: apply it to the BASELINE so that hunk stops counting
 * as "pending change" while the rest of the file's diff survives.
 */
export function acceptHunk(key: CheckpointKey, relPath: string, hunkIndex: number): boolean {
  const manifest = readManifest(key);
  const entry = manifest?.files[relPath];
  if (!manifest || !entry) return false;
  const baseline = readBaseline(key, entry);
  const current = currentContent(manifest.cwd, relPath);
  const patch = singleHunkPatch(relPath, baseline, current, hunkIndex);
  if (!patch) return false;
  const advanced = applyPatch(baseline ?? "", patch);
  if (advanced === false) return false;
  entry.baselineBlob = writeBaseline(key, relPath, advanced);
  // Baseline caught up with disk entirely → entry is settled.
  if (advanced === (current ?? "")) dropEntry(key, manifest, relPath);
  writeManifest(key, manifest);
  return true;
}

/**
 * Reject one hunk: reverse-apply it to the file ON DISK. The baseline is
 * untouched; the next recompute simply no longer contains the hunk.
 */
export function rejectHunk(key: CheckpointKey, relPath: string, hunkIndex: number): boolean {
  const manifest = readManifest(key);
  const entry = manifest?.files[relPath];
  if (!manifest || !entry) return false;
  const baseline = readBaseline(key, entry);
  const current = currentContent(manifest.cwd, relPath);
  const patch = singleHunkPatch(relPath, baseline, current, hunkIndex);
  if (!patch) return false;
  const reverted = applyPatch(current ?? "", reversePatch(patch));
  if (reverted === false) return false;
  const abs = join(manifest.cwd, relPath);
  if (reverted === "" && baseline === null) {
    // Rejecting the only hunk of an added file = the file shouldn't exist.
    try {
      unlinkSync(abs);
    } catch {
      /* gone */
    }
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, reverted, "utf-8");
  }
  if (reverted === (baseline ?? "")) dropEntry(key, manifest, relPath);
  writeManifest(key, manifest);
  return true;
}

/** Accept everything: forget all baselines, keep the disk as-is. */
export function acceptAll(key: CheckpointKey): number {
  const manifest = readManifest(key);
  if (!manifest) return 0;
  const n = Object.keys(manifest.files).length;
  try {
    rmSync(marvinPaths.checkpointsDir(key.projectId, key.marvinSessionId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* best-effort */
  }
  return n;
}

/** Reject everything: restore every baseline. Returns files restored. */
export function rejectAll(key: CheckpointKey): number {
  const manifest = readManifest(key);
  if (!manifest) return 0;
  let n = 0;
  for (const rel of Object.keys(manifest.files)) {
    if (rejectFile(key, rel)) n += 1;
  }
  return n;
}

/** Test-only convenience: wipe a session's checkpoint store. */
export function __clearCheckpointsForTests(key: CheckpointKey): void {
  rmSync(marvinPaths.checkpointsDir(key.projectId, key.marvinSessionId), {
    recursive: true,
    force: true,
  });
}
