/**
 * The backlog says when it changed (ADR-0044 addendum, 2026-11-25).
 *
 * The app's "N backlog items parked" strip read the count once, when a session
 * was created, and never again: the backlog is PROJECT state, written all day
 * by other sessions' tools, by the user in the Project Backlog window, by hand,
 * and by a git checkout, and none of that reached a client that had already
 * looked. This module is the sidecar half of the fix. It
 *
 *   - counts the project's items by status (and `blocked`) WITHOUT parsing the
 *     directory on every event: an incremental scan that `lstat`s each file and
 *     re-reads only the ones whose mtime or size moved;
 *   - turns every write — the store's own (`noteBacklogWrite`, called from the
 *     one function every write path goes through) and a change from outside
 *     MARVIN (one `fs.watch` on `.marvin/backlog` per project) — into ONE
 *     debounced signal carrying the new counts. Both sources feed the same
 *     debouncer, so a tool write that the watcher also sees is still one signal.
 *
 * A path inside the user's repository is attacker-controlled input
 * (REVIEW.md "Project-controlled config"): the directory and every entry are
 * `lstat`ed, a symlink is never followed, and the scan is bounded.
 */

import { type FSWatcher, lstatSync, watch as fsWatch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface BacklogCounts {
  provisional: number;
  open: number;
  doing: number;
  done: number;
  dismissed: number;
  /** Items flagged `blocked: true`, in any status. */
  blocked: number;
  /** provisional + open + doing — the number the strip shows. */
  active: number;
}

export const EMPTY_BACKLOG_COUNTS: BacklogCounts = Object.freeze({
  provisional: 0,
  open: 0,
  doing: 0,
  done: 0,
  dismissed: 0,
  blocked: 0,
  active: 0,
});

export interface BacklogChange {
  workDir: string;
  /** Per-project counter, 0 before the first change. A client drops an older `change`. */
  revision: number;
  counts: BacklogCounts;
  /** `snapshot` = the state now (a new subscriber); `change` = the backlog moved. */
  reason: "snapshot" | "change";
}

/**
 * The wire shape of `backlog.changed` on `/api/chat/announce`: counts and a
 * revision, never a path or a title — that stream holds no token.
 */
export function backlogChangedPayload(projectId: string, c: BacklogChange) {
  return { projectId, revision: c.revision, reason: c.reason, counts: c.counts };
}

/** A directory bigger than this is counted by its first N names: a hostile repo cannot make a scan unbounded. */
export const MAX_BACKLOG_FILES = 20_000;

const STATUSES = ["provisional", "open", "doing", "done", "dismissed"] as const;

/** Pure: tally rows. An unknown status reads as `open`, like `parseItem`. */
export function countsFromRows(rows: ReadonlyArray<{ status: string; blocked: boolean }>): BacklogCounts {
  const c = { ...EMPTY_BACKLOG_COUNTS };
  for (const r of rows) {
    const s = (STATUSES as readonly string[]).includes(r.status) ? (r.status as (typeof STATUSES)[number]) : "open";
    c[s] += 1;
    if (r.blocked) c.blocked += 1;
  }
  c.active = c.provisional + c.open + c.doing;
  return c;
}

// Same first-match, horizontal-whitespace-only reading as backlog.ts `parseField`.
function field(content: string, name: string): string {
  return new RegExp(`^${name}:[^\\S\\n]*(.*)$`, "m").exec(content)?.[1]?.trim() ?? "";
}

interface CachedRow {
  mtimeMs: number;
  size: number;
  status: string;
  blocked: boolean;
}

/** Incremental counter. One instance keeps one cache per project. */
export function createBacklogCounter(): { count(workDir: string): Promise<BacklogCounts> } {
  const caches = new Map<string, Map<string, CachedRow>>();
  return {
    async count(workDir: string): Promise<BacklogCounts> {
      const dir = join(workDir, ".marvin", "backlog");
      let names: string[];
      try {
        // lstat: a symlinked directory is not followed out of the project.
        if (!(await lstat(dir)).isDirectory()) throw new Error("not a directory");
        names = (await readdir(dir)).filter((n) => n.endsWith(".md")).slice(0, MAX_BACKLOG_FILES);
      } catch {
        caches.delete(workDir);
        return { ...EMPTY_BACKLOG_COUNTS };
      }
      const cache = caches.get(workDir) ?? new Map<string, CachedRow>();
      const next = new Map<string, CachedRow>();
      const BATCH = 64;
      for (let i = 0; i < names.length; i += BATCH) {
        await Promise.all(
          names.slice(i, i + BATCH).map(async (name) => {
            try {
              const path = join(dir, name);
              const st = await lstat(path);
              if (!st.isFile()) return; // a symlink or a directory is not an item
              const hit = cache.get(name);
              if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
                next.set(name, hit);
                return;
              }
              const content = await readFile(path, "utf-8");
              next.set(name, {
                mtimeMs: st.mtimeMs,
                size: st.size,
                status: field(content, "status"),
                blocked: field(content, "blocked") === "true",
              });
            } catch {
              /* vanished or unreadable between readdir and read: not counted */
            }
          }),
        );
      }
      caches.set(workDir, next);
      return countsFromRows([...next.values()]);
    },
  };
}

type Listener = (change: BacklogChange) => void;

interface Slot {
  revision: number;
  listeners: Set<Listener>;
  quiet: ReturnType<typeof setTimeout> | null;
  max: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  dirty: boolean;
  watchRefs: number;
  watcher: FSWatcher | null;
  watchedIno: number | null;
  health: ReturnType<typeof setInterval> | null;
}

export interface BacklogLiveOptions {
  /** Quiet period after the last write before the signal goes out. */
  debounceMs?: number;
  /** A steady stream of writes still signals at least this often. */
  maxWaitMs?: number;
  /** How often a watched directory is checked for having been replaced. */
  healthMs?: number;
  count?: (workDir: string) => Promise<BacklogCounts>;
}

export interface BacklogLive {
  noteWrite(workDir: string): void;
  subscribe(workDir: string, listener: Listener): () => void;
  /** The state now, without bumping the revision. */
  snapshot(workDir: string): Promise<BacklogChange>;
  /** Start (refcounted) the file-system watch for a project; returns the release. */
  watch(workDir: string): () => void;
  watchedCount(): number;
}

export function createBacklogLive(opts: BacklogLiveOptions = {}): BacklogLive {
  const debounceMs = opts.debounceMs ?? 300;
  const maxWaitMs = opts.maxWaitMs ?? 1500;
  const healthMs = opts.healthMs ?? 30_000;
  const counter = createBacklogCounter();
  const count = opts.count ?? ((w: string) => counter.count(w));
  const slots = new Map<string, Slot>();

  const slotFor = (raw: string): { key: string; slot: Slot } => {
    const key = resolve(raw);
    let slot = slots.get(key);
    if (!slot) {
      slot = { revision: 0, listeners: new Set(), quiet: null, max: null, flushing: false, dirty: false, watchRefs: 0, watcher: null, watchedIno: null, health: null };
      slots.set(key, slot);
    }
    return { key, slot };
  };

  async function flush(key: string, slot: Slot): Promise<void> {
    if (slot.quiet) clearTimeout(slot.quiet);
    if (slot.max) clearTimeout(slot.max);
    slot.quiet = slot.max = null;
    if (slot.flushing) {
      slot.dirty = true;
      return;
    }
    slot.flushing = true;
    try {
      do {
        slot.dirty = false;
        if (slot.listeners.size === 0) break; // nobody to tell; the next subscriber gets a snapshot
        let counts: BacklogCounts;
        try {
          counts = await count(key);
        } catch {
          break; // unreadable right now: stay quiet, the next write retries
        }
        slot.revision += 1;
        const change: BacklogChange = { workDir: key, revision: slot.revision, counts, reason: "change" };
        for (const l of [...slot.listeners]) {
          try {
            l(change);
          } catch {
            /* a listener must not break the others */
          }
        }
      } while (slot.dirty);
    } finally {
      slot.flushing = false;
    }
  }

  function noteWrite(raw: string): void {
    const { key, slot } = slotFor(raw);
    if (slot.quiet) clearTimeout(slot.quiet);
    slot.quiet = setTimeout(() => void flush(key, slot), debounceMs);
    slot.quiet.unref?.();
    if (!slot.max) {
      slot.max = setTimeout(() => void flush(key, slot), maxWaitMs);
      slot.max.unref?.();
    }
  }

  function attach(key: string, slot: Slot): void {
    const dir = join(key, ".marvin", "backlog");
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory()) return; // a symlink is never watched
      const w = fsWatch(dir, { persistent: false }, (_event, name) => {
        if (name && !String(name).endsWith(".md")) return;
        noteWrite(key);
      });
      w.on("error", () => detach(slot));
      slot.watcher = w;
      slot.watchedIno = st.ino;
    } catch {
      /* no directory yet: the health check attaches it when it appears */
    }
  }

  function detach(slot: Slot): void {
    try {
      slot.watcher?.close();
    } catch {
      /* already closed */
    }
    slot.watcher = null;
    slot.watchedIno = null;
  }

  return {
    noteWrite,
    subscribe(workDir, listener) {
      const { slot } = slotFor(workDir);
      slot.listeners.add(listener);
      return () => {
        slot.listeners.delete(listener);
      };
    },
    async snapshot(workDir) {
      const { key, slot } = slotFor(workDir);
      return { workDir: key, revision: slot.revision, counts: await count(key), reason: "snapshot" };
    },
    watch(workDir) {
      const { key, slot } = slotFor(workDir);
      slot.watchRefs += 1;
      if (slot.watchRefs === 1) {
        attach(key, slot);
        // A directory replaced under the watch (a checkout that removes and
        // recreates it) leaves a watcher on a dead inode; look every so often.
        slot.health = setInterval(() => {
          let ino: number | null = null;
          try {
            const st = lstatSync(join(key, ".marvin", "backlog"));
            ino = st.isDirectory() ? st.ino : null;
          } catch {
            ino = null;
          }
          if (ino === slot.watchedIno) return;
          detach(slot);
          if (ino !== null) attach(key, slot);
          noteWrite(key);
        }, healthMs);
        slot.health.unref?.();
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        slot.watchRefs -= 1;
        if (slot.watchRefs === 0) {
          detach(slot);
          if (slot.health) clearInterval(slot.health);
          slot.health = null;
        }
      };
    },
    watchedCount() {
      let n = 0;
      for (const s of slots.values()) if (s.watchRefs > 0) n += 1;
      return n;
    },
  };
}

// One hub per process, pinned to globalThis: the store is imported by the chat
// route (the MCP tool), /api/backlog and the announce stream, which Next may
// bundle as separate module copies; the signal must meet its listeners.
const KEY = Symbol.for("marvin.backlogLive");
let override: BacklogLive | null = null;

export function getBacklogLive(): BacklogLive {
  if (override) return override;
  const g = globalThis as unknown as Record<symbol, BacklogLive | undefined>;
  return (g[KEY] ??= createBacklogLive());
}

/** Tests install their own hub (short debounce); `null` restores the process one. */
export function setBacklogLiveForTests(hub: BacklogLive | null): void {
  override = hub;
}

/** Called by the store after every write. Cheap: a timer reset. */
export function noteBacklogWrite(workDir: string): void {
  getBacklogLive().noteWrite(workDir);
}
