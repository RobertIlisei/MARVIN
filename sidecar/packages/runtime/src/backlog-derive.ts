/**
 * An item is done when git says so (ADR-0044 addendum, 2026-11-27).
 *
 * A commit may end its message with a trailer, `Backlog: <slug>` (one line per
 * item, several allowed). An open or doing item whose slug appears in such a
 * trailer on a commit REACHABLE FROM the project's integration branch is done:
 * the sha is its evidence. Same shape as `reconcileWorktrees` (ADR-0103): the
 * state is derived from git on read, because the fix lands in a tab, on a
 * release branch, in a merge, from a terminal — and MARVIN is not there to see
 * it. Measured 2026-11-26 on a real project: 54 items filed, about 50 left open
 * after the fixes had merged, because nobody went back to resolve them.
 *
 * The decisions, each with the reason:
 *
 *  - **Integration branch** = the base MARVIN cuts tabs from: the `baseRef` its
 *    worktree records carry (`worktrees.ts`; the most common one, while that
 *    branch still exists). MARVIN has no other configured base, and a merge
 *    train working in the main checkout may leave it on another branch or
 *    half-way through a merge — so the checkout's own branch is only the
 *    FALLBACK, for a project with no worktree record yet. A merge or rebase in
 *    progress in the main checkout derives nothing on that read (the tip is
 *    about to move; the next read tries again), and so does a detached HEAD
 *    when the fallback is all there is — each says so in `skipped`.
 *    Reachability, not a branch name, is the test: a fix committed on a release
 *    branch counts the moment that branch merges in, with no rule for it.
 *  - **One git call, not one per item.** `git log --grep=^Backlog:` over the
 *    branch, bounded at MAX_COMMITS, parsed once. The result is cached by the
 *    branch tip: an unchanged tip costs one `rev-parse`; a moved tip scans only
 *    `oldTip..newTip` (when the old tip is still an ancestor) and merges it into
 *    the cache. A burst of callers inside TTL_MS shares the answer.
 *  - **A slug that names no item** is reported (`unknown`), never created. A
 *    typo in a trailer must not manufacture work.
 *  - **Only a commit made after the item was filed (or last reopened) counts.**
 *    Otherwise re-filing a title that was fixed last month would close itself
 *    on the next read, and so would a reopen.
 *  - **An item that is already resolved is not touched.** A person's `done` or
 *    `dismissed` stands; only open and doing items are derived. Provisional
 *    items wait for the person's keep/dismiss (ADR-0047) — a trailer is not
 *    that decision.
 *  - **A revert** (the commit the trailer is on is reverted later): derived done
 *    stays done. A revert commit carries no `Backlog:` trailer of its own, so
 *    nothing re-derives; the fix is no longer on the branch, and that is a new
 *    piece of work, so it is a new item (or `backlog_resolve keep` reopens this
 *    one by hand, which also stamps `reopenedAt`).
 *  - **Squash and rebase** rewrite commits but not the trailer in a message that
 *    is kept; the match is on the trailer, never on a sha. A squash that drops
 *    the message drops the evidence — the item stays open, which is the safe
 *    direction.
 *
 * Never a model's decision and never an agent closing its own ticket (ADR-0044,
 * Golden Rule 1): the trailer is the author's claim, reachability is git's
 * proof, and the resolution is marked `resolvedBy: derived` so the keep/dismiss
 * review and the person can tell it from a decision.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getBacklogItem, listBacklog, resolveDerivedBacklogItem } from "./backlog";
import { listWorktrees } from "./worktrees";

const execFileAsync = promisify(execFile);

/** Commits examined per scan. A repository with more `Backlog:` commits than this is not one this was built for. */
export const MAX_COMMITS = 20_000;
/** Callers inside this window share one answer. */
export const DERIVE_TTL_MS = 10_000;
const GIT_TIMEOUT_MS = 20_000;
const MAX_UNKNOWN_REPORTED = 50;

export interface TrailerCommit {
  sha: string;
  /** Committer date, ISO. */
  date: string;
  subject: string;
}

export interface DerivedReport {
  /** The integration branch, or null when none could be determined. */
  branch: string | null;
  /** Why nothing was derived (no repository, detached HEAD, git failed). */
  skipped?: string;
  /** Items closed by this run. */
  resolved: Array<{ id: string; sha: string; subject: string }>;
  /** Slugs a trailer names that match no item, open or closed. */
  unknown: string[];
  /** Commits carrying a `Backlog:` trailer that the cache holds. */
  trailerCommits: number;
  /** True when no git history was read for this call (the cache answered). */
  cached: boolean;
}

interface Cache {
  branch: string;
  tip: string;
  bySlug: Map<string, TrailerCommit[]>;
  commits: number;
  at: number;
}

const caches = new Map<string, Cache>();
const inflight = new Map<string, Promise<DerivedReport>>();

async function git(workDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workDir,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    // A read must not take index.lock out from under a merge or a commit (git-env.ts).
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

export interface IntegrationChoice {
  branch: string | null;
  /** `configured`: the base tabs are cut from. `checkout`: the main checkout's branch, the fallback. */
  source?: "configured" | "checkout";
  /** Why nothing can be derived on this read. */
  skipped?: string;
}

/** A merge or rebase is under way in the main checkout (a merge train working there). */
async function operationInProgress(workDir: string): Promise<string | null> {
  try {
    const gitDir = (await git(workDir, ["rev-parse", "--absolute-git-dir"])).trim();
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
      if (existsSync(join(gitDir, marker))) return marker === "MERGE_HEAD" ? "merge" : marker.startsWith("rebase") ? "rebase" : "cherry-pick";
    }
  } catch {
    /* not a repository: reported below */
  }
  return null;
}

/** The branch a `Backlog:` trailer must be reachable from, and why there is none when there is none. */
export async function integrationBranch(workDir: string): Promise<IntegrationChoice> {
  try {
    await git(workDir, ["rev-parse", "--git-dir"]);
  } catch {
    return { branch: null, skipped: "not a git repository" };
  }
  const busy = await operationInProgress(workDir);
  if (busy) return { branch: null, skipped: `a ${busy} is in progress in the main checkout; the next read tries again` };
  const counts = new Map<string, number>();
  for (const w of listWorktrees(workDir)) if (w.baseRef) counts.set(w.baseRef, (counts.get(w.baseRef) ?? 0) + 1);
  for (const [ref] of [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const exists = await git(workDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`]).then(
      () => true,
      () => false,
    );
    if (exists) return { branch: ref, source: "configured" };
  }
  try {
    const head = (await git(workDir, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    if (head) return { branch: head, source: "checkout" };
  } catch {
    /* detached */
  }
  return { branch: null, skipped: "no integration branch: HEAD is detached and no tab base is recorded" };
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Parse `git log --format=%H%x00%cI%x00%s%x00%(trailers:key=Backlog,valueonly)%x1e`.
 * Each `Backlog:` value is one or more slugs separated by spaces or commas.
 */
export function parseTrailerLog(out: string): { bySlug: Map<string, TrailerCommit[]>; commits: number } {
  const bySlug = new Map<string, TrailerCommit[]>();
  let commits = 0;
  for (const rec of out.split("\x1e")) {
    const [sha, date, subject, values] = rec.replace(/^\n+/, "").split("\0");
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha.trim()) || values === undefined) continue;
    const commit: TrailerCommit = { sha: sha.trim(), date: (date ?? "").trim(), subject: (subject ?? "").trim() };
    let any = false;
    for (const v of values.split("\n")) {
      for (const tok of v.toLowerCase().split(/[\s,]+/)) {
        if (!SLUG.test(tok)) continue;
        any = true;
        const list = bySlug.get(tok) ?? [];
        if (!list.some((c) => c.sha === commit.sha)) list.push(commit);
        bySlug.set(tok, list);
      }
    }
    if (any) commits += 1;
  }
  return { bySlug, commits };
}

const LOG_FORMAT = "--format=%H%x00%cI%x00%s%x00%(trailers:key=Backlog,valueonly)%x1e";

async function scan(workDir: string, range: string): Promise<{ bySlug: Map<string, TrailerCommit[]>; commits: number }> {
  return parseTrailerLog(await git(workDir, ["log", range, `--max-count=${MAX_COMMITS}`, "-i", "--grep=^Backlog:", LOG_FORMAT]));
}

function mergeInto(into: Map<string, TrailerCommit[]>, from: Map<string, TrailerCommit[]>): void {
  for (const [slug, list] of from) {
    const cur = into.get(slug) ?? [];
    for (const c of list) if (!cur.some((x) => x.sha === c.sha)) cur.push(c);
    into.set(slug, cur);
  }
}

/** Bring the cache to the branch tip: nothing, an increment, or a full scan. */
async function refresh(workDir: string, branch: string, now: number): Promise<{ cache: Cache; cached: boolean }> {
  const tip = (await git(workDir, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
  const prev = caches.get(workDir);
  if (prev && prev.branch === branch && prev.tip === tip) {
    prev.at = now;
    return { cache: prev, cached: true };
  }
  let next: Cache;
  const incremental =
    prev && prev.branch === branch
      ? await git(workDir, ["merge-base", "--is-ancestor", prev.tip, tip]).then(
          () => true,
          () => false,
        )
      : false;
  if (prev && incremental) {
    const added = await scan(workDir, `${prev.tip}..${tip}`);
    const bySlug = new Map(prev.bySlug);
    mergeInto(bySlug, added.bySlug);
    next = { branch, tip, bySlug, commits: prev.commits + added.commits, at: now };
  } else {
    const all = await scan(workDir, tip);
    next = { branch, tip, bySlug: all.bySlug, commits: all.commits, at: now };
  }
  caches.set(workDir, next);
  return { cache: next, cached: false };
}

/** The moment an item became eligible: filed, or last reopened, whichever is later. */
function eligibleSince(item: { created: string; reopenedAt: string }): number {
  const times = [item.created, item.reopenedAt].map((s) => Date.parse(s)).filter((n) => Number.isFinite(n));
  // Commit dates are whole seconds; an item filed in the same second as its fix still counts as filed before it.
  return times.length ? Math.floor(Math.max(...times) / 1000) * 1000 : 0;
}

/** Resolve the open/doing items the cache proves fixed; returns the ids that were open, for the `unknown` check. */
async function closeFixed(workDir: string, cache: Cache, report: DerivedReport): Promise<Set<string>> {
  const open = (await listBacklog(workDir)).filter((i) => i.status === "open" || i.status === "doing");
  for (const item of open) {
    const commits = cache.bySlug.get(item.id);
    if (!commits?.length) continue;
    const since = eligibleSince(item);
    // The oldest qualifying commit is the fix; a later one that cites the same
    // item is a follow-up on something already fixed.
    const proof = commits
      .filter((c) => Date.parse(c.date) >= since)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
    if (!proof) continue;
    const res = await resolveDerivedBacklogItem(workDir, item.id, { sha: proof.sha, subject: proof.subject, branch: cache.branch });
    if (res.ok) report.resolved.push({ id: item.id, sha: proof.sha, subject: proof.subject });
  }
  return new Set(open.map((i) => i.id));
}

async function run(workDir: string, now: number): Promise<DerivedReport> {
  const empty = (skipped: string, branch: string | null = null): DerivedReport => ({ branch, skipped, resolved: [], unknown: [], trailerCommits: 0, cached: false });
  const chosen = await integrationBranch(workDir);
  const branch = chosen.branch;
  if (!branch) return empty(chosen.skipped ?? "no integration branch");
  let state: { cache: Cache; cached: boolean };
  try {
    state = await refresh(workDir, branch, now);
  } catch (err) {
    return empty(`git could not be read: ${(err as Error).message.split("\n")[0]}`, branch);
  }
  const { cache, cached } = state;
  const report: DerivedReport = { branch, resolved: [], unknown: [], trailerCommits: cache.commits, cached };
  if (cache.bySlug.size === 0) return report;

  const openIds = await closeFixed(workDir, cache, report);
  // A trailer naming nothing: neither open here nor among the closed items.
  for (const slug of cache.bySlug.keys()) {
    if (openIds.has(slug)) continue;
    if (!(await getBacklogItem(workDir, slug))) {
      report.unknown.push(slug);
      if (report.unknown.length >= MAX_UNKNOWN_REPORTED) break;
    }
  }
  return report;
}

/**
 * Close every open or doing item whose fix is on the integration branch, and
 * report it. Safe to call from anywhere, often: calls inside `DERIVE_TTL_MS`
 * share one answer, concurrent calls share one run, and a repository that has
 * not moved costs one `rev-parse`. Never throws.
 */
export function deriveBacklogFromGit(workDir: string, opts: { force?: boolean; now?: number } = {}): Promise<DerivedReport> {
  const now = opts.now ?? Date.now();
  const running = inflight.get(workDir);
  if (running) return running;
  const prev = caches.get(workDir);
  const p = (async () => {
    if (!opts.force && prev && now - prev.at < DERIVE_TTL_MS) {
      // Inside the window: no git at all. Items filed since the last run are
      // still checked against what the cache holds.
      return runFromCache(workDir, prev);
    }
    try {
      return await run(workDir, now);
    } catch (err) {
      return { branch: null, skipped: (err as Error).message, resolved: [], unknown: [], trailerCommits: 0, cached: false } satisfies DerivedReport;
    }
  })().finally(() => inflight.delete(workDir));
  inflight.set(workDir, p);
  return p;
}

async function runFromCache(workDir: string, cache: Cache): Promise<DerivedReport> {
  const report: DerivedReport = { branch: cache.branch, resolved: [], unknown: [], trailerCommits: cache.commits, cached: true };
  if (cache.bySlug.size > 0) await closeFixed(workDir, cache, report);
  return report;
}

/** Tests: forget what was scanned. */
export function resetBacklogDeriveForTests(): void {
  caches.clear();
  inflight.clear();
}
