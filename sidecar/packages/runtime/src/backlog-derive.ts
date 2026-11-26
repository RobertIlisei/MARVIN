/**
 * An item is done when git says so (ADR-0044 amendment, 2026-11-27).
 *
 * A commit that completes backlog items ends its message with the trailer
 * `Fixes-Backlog: <slug>[, <slug>…]`. An open or doing item whose slug is in
 * such a trailer on a commit REACHABLE FROM the project's integration branch is
 * done: the sha is its evidence. Same shape as `reconcileWorktrees` (ADR-0103):
 * the state is derived from git on read, because the fix lands in a tab, on a
 * release branch, in a merge, from a terminal — and MARVIN is not there to see
 * it. Measured 2026-11-26 on a real project: 54 items filed, about 50 left open
 * after the fixes had merged, because nobody went back to resolve them.
 *
 * The decisions, each with the reason:
 *
 *  - **A key that only means "completes it".** The first version read
 *    `Backlog: <slug>`, and the real repository already has commit bodies such
 *    as `Backlog: <slug>, points 1 to 4.` and `Backlog: a (tab half), b` — a
 *    reference, a half, a mention. Read as closers they close the wrong item,
 *    and the prose tokens ("points", "to", "1") pass a slug pattern, so a
 *    one-word slug could be closed by an unrelated line. `Backlog:` therefore
 *    stays a reference and closes nothing; only `Fixes-Backlog:` does, and only
 *    when the WHOLE value is a comma-separated list of slugs that all exist
 *    (open or closed). Any other line is ignored — nothing on it closes — and
 *    reported once (`ignored`), so a typo is seen rather than half-obeyed.
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
 *  - **One git call, not one per item, and only when the branch moved.**
 *    `git log --grep=^Fixes-Backlog:` over the branch, bounded at MAX_COMMITS,
 *    parsed once and cached by the branch tip: an unchanged tip costs one
 *    `rev-parse` and NO scan of the backlog (a pane open, a list, a turn start
 *    must not each read the store); a moved tip scans only `oldTip..newTip` (when
 *    the old tip is still an ancestor), then closes what the new commits prove.
 *    Calls inside DERIVE_TTL_MS skip even the `rev-parse`. Each closure updates
 *    the closed index by one line (`noteItemWritten`), never a rebuild.
 *    Why skipping the scan on an unchanged tip is sound: an item filed after the
 *    last derivation is newer than every commit already seen, and a commit only
 *    counts when it is newer than the item.
 *  - **A claim held by an open tab is not closed from under it.** An item that
 *    is `doing` with a `claimedBy` whose session is still open (it has a
 *    session meta and no `closedAt`) is SKIPPED and reported (`held`); the next
 *    run after the tab closes or releases it, or the tab's own `backlog_resolve`,
 *    closes it. Closing it would clear a live tab's claim mid-work and send its
 *    scope-met check (ADR-0137) looking for an item that no longer says `doing`.
 *    A claim whose session is closed or unknown is stale and is cleared with the
 *    closure, as any resolution clears it.
 *  - **Only a commit made after the item was filed (or last reopened) counts.**
 *    Otherwise re-filing a title that was fixed last month would close itself
 *    on the next read, and so would a reopen.
 *  - **An item that is already resolved is not touched.** A person's `done` or
 *    `dismissed` stands; only open and doing items are derived. Provisional
 *    items wait for the person's keep/dismiss (ADR-0047) — a trailer is not
 *    that decision.
 *  - **A revert** (the commit the trailer is on is reverted later): derived done
 *    stays done. A revert commit carries no `Fixes-Backlog:` trailer of its own,
 *    so nothing re-derives; the fix is no longer on the branch, and that is a
 *    new piece of work, so it is a new item (or `backlog_resolve keep` reopens
 *    this one by hand, which also stamps `reopenedAt`).
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

import { backlogSlugs, listBacklog, resolveDerivedBacklogItem } from "./backlog";
import { slugifyWorkDir } from "./projects";
import { readSessionMeta } from "./session-meta";
import { listWorktrees } from "./worktrees";

const execFileAsync = promisify(execFile);

/** Commits examined per scan. A repository with more `Fixes-Backlog:` commits than this is not one this was built for. */
export const MAX_COMMITS = 20_000;
/** Callers inside this window share one answer, with no git at all. */
export const DERIVE_TTL_MS = 10_000;
/** The only trailer that closes an item. */
export const FIXES_TRAILER = "Fixes-Backlog";
const GIT_TIMEOUT_MS = 20_000;
const MAX_IGNORED_REPORTED = 20;

export interface TrailerCommit {
  sha: string;
  /** Committer date, ISO. */
  date: string;
  subject: string;
}

/** One `Fixes-Backlog:` line that parsed as a list of slugs. */
export interface TrailerGroup {
  commit: TrailerCommit;
  slugs: string[];
}

/** A `Fixes-Backlog:` line that closes nothing, and why. */
export interface IgnoredLine {
  sha: string;
  value: string;
  why: string;
}

export interface DerivedReport {
  /** The integration branch, or null when none could be determined. */
  branch: string | null;
  /** Why nothing was derived (no repository, detached HEAD, merge in progress, git failed). */
  skipped?: string;
  /** Items closed by this run. */
  resolved: Array<{ id: string; sha: string; subject: string }>;
  /** Lines that closed nothing (malformed, or naming a slug that does not exist), newly seen by this process. */
  ignored: IgnoredLine[];
  /** Items a trailer proves fixed but that an open tab holds: left alone until the tab lets go. */
  held: string[];
  /** Commits carrying a `Fixes-Backlog:` trailer that the cache holds. */
  trailerCommits: number;
  /** True when no git history was read for this call (the cache answered). */
  cached: boolean;
}

interface Cache {
  branch: string;
  tip: string;
  groups: TrailerGroup[];
  malformed: IgnoredLine[];
  commits: number;
  at: number;
  /** Items proven fixed but held by an open tab: they are looked at again even when the tip has not moved. */
  pending: Set<string>;
}

const caches = new Map<string, Cache>();
const inflight = new Map<string, Promise<DerivedReport>>();
/** Ignored lines already reported by this process, so a bad line is said once. */
const reported = new Set<string>();

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

/** The branch a `Fixes-Backlog:` trailer must be reachable from, and why there is none when there is none. */
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
 * Parse one trailer value as a comma-separated list of slugs. The WHOLE value
 * must parse — a single token that is not a slug (a word, a number, a trailing
 * full stop) rejects the line, so prose can never be read as a slug.
 */
export function parseSlugList(value: string): { ok: true; slugs: string[] } | { ok: false; why: string } {
  const text = value.trim();
  if (!text) return { ok: false, why: "empty value" };
  const slugs: string[] = [];
  for (const raw of text.split(",")) {
    const tok = raw.trim().toLowerCase();
    if (!SLUG.test(tok)) return { ok: false, why: `"${raw.trim()}" is not a slug (the whole value must be a comma-separated list of slugs)` };
    if (!slugs.includes(tok)) slugs.push(tok);
  }
  return { ok: true, slugs };
}

/**
 * Parse `git log --format=%H%x00%cI%x00%s%x00%(trailers:key=Fixes-Backlog,valueonly,unfold)%x1e`.
 * Every trailer line is one group of slugs, or an ignored line.
 */
export function parseTrailerLog(out: string): { groups: TrailerGroup[]; malformed: IgnoredLine[]; commits: number } {
  const groups: TrailerGroup[] = [];
  const malformed: IgnoredLine[] = [];
  let commits = 0;
  for (const rec of out.split("\x1e")) {
    const [sha, date, subject, values] = rec.replace(/^\n+/, "").split("\0");
    if (!sha || !/^[0-9a-f]{7,64}$/.test(sha.trim()) || values === undefined) continue;
    const commit: TrailerCommit = { sha: sha.trim(), date: (date ?? "").trim(), subject: (subject ?? "").trim() };
    let any = false;
    for (const line of values.split("\n")) {
      if (!line.trim()) continue;
      any = true;
      const parsed = parseSlugList(line);
      if (parsed.ok) groups.push({ commit, slugs: parsed.slugs });
      else malformed.push({ sha: commit.sha, value: line.trim().slice(0, 160), why: parsed.why });
    }
    if (any) commits += 1;
  }
  return { groups, malformed, commits };
}

const LOG_FORMAT = `--format=%H%x00%cI%x00%s%x00%(trailers:key=${FIXES_TRAILER},valueonly,unfold)%x1e`;

async function scan(workDir: string, range: string): Promise<ReturnType<typeof parseTrailerLog>> {
  return parseTrailerLog(await git(workDir, ["log", range, `--max-count=${MAX_COMMITS}`, "-i", `--grep=^${FIXES_TRAILER}:`, LOG_FORMAT]));
}

/** Bring the cache to the branch tip: nothing, an increment, or a full scan. `moved` is false when the tip is the one already derived from. */
async function refresh(workDir: string, branch: string, now: number): Promise<{ cache: Cache; moved: boolean }> {
  const tip = (await git(workDir, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
  const prev = caches.get(workDir);
  if (prev && prev.branch === branch && prev.tip === tip) {
    prev.at = now;
    return { cache: prev, moved: false };
  }
  const incremental =
    prev && prev.branch === branch
      ? await git(workDir, ["merge-base", "--is-ancestor", prev.tip, tip]).then(
          () => true,
          () => false,
        )
      : false;
  let next: Cache;
  if (prev && incremental) {
    const added = await scan(workDir, `${prev.tip}..${tip}`);
    next = { branch, tip, groups: [...prev.groups, ...added.groups], malformed: [...prev.malformed, ...added.malformed], commits: prev.commits + added.commits, at: now, pending: prev.pending };
  } else {
    const all = await scan(workDir, tip);
    next = { branch, tip, groups: all.groups, malformed: all.malformed, commits: all.commits, at: now, pending: new Set() };
  }
  caches.set(workDir, next);
  return { cache: next, moved: true };
}

/** The moment an item became eligible: filed, or last reopened, whichever is later. */
function eligibleSince(item: { created: string; reopenedAt: string }): number {
  const times = [item.created, item.reopenedAt].map((s) => Date.parse(s)).filter((n) => Number.isFinite(n));
  // Commit dates are whole seconds; an item filed in the same second as its fix still counts as filed before it.
  return times.length ? Math.floor(Math.max(...times) / 1000) * 1000 : 0;
}

/** Is the tab that holds this claim still open? A session with a meta and no `closedAt` is; anything else is a stale claim. */
function sessionIsOpen(workDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const meta = readSessionMeta(slugifyWorkDir(workDir), sessionId);
  return !!meta && !meta.closedAt;
}

/**
 * Close the open/doing items the trailers prove fixed. A line whose slugs do not
 * ALL exist is ignored whole; ignored lines are reported once per process.
 */
async function closeFixed(workDir: string, cache: Cache, report: DerivedReport): Promise<void> {
  const exists = await backlogSlugs(workDir);
  const bySlug = new Map<string, TrailerCommit[]>();
  const fresh: IgnoredLine[] = [];
  const note = (l: IgnoredLine) => {
    const key = `${workDir}\0${l.sha}\0${l.value}`;
    if (!reported.has(key) && fresh.length < MAX_IGNORED_REPORTED) {
      reported.add(key);
      fresh.push(l);
    }
  };
  for (const m of cache.malformed) note(m);
  for (const g of cache.groups) {
    const missing = g.slugs.filter((s) => !exists.has(s));
    if (missing.length > 0) {
      note({ sha: g.commit.sha, value: g.slugs.join(", "), why: `names no backlog item: ${missing.join(", ")} (nothing on this line was closed)` });
      continue;
    }
    for (const s of g.slugs) bySlug.set(s, [...(bySlug.get(s) ?? []), g.commit]);
  }
  report.ignored.push(...fresh);
  cache.pending = new Set();
  if (bySlug.size === 0) return;

  const open = (await listBacklog(workDir)).filter((i) => i.status === "open" || i.status === "doing");
  for (const item of open) {
    const commits = bySlug.get(item.id);
    if (!commits?.length) continue;
    const since = eligibleSince(item);
    // The oldest qualifying commit is the fix; a later one that cites the same
    // item is a follow-up on something already fixed.
    const proof = commits
      .filter((c) => Date.parse(c.date) >= since)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
    if (!proof) continue;
    if (item.status === "doing" && sessionIsOpen(workDir, item.claimedBy)) {
      report.held.push(item.id);
      cache.pending.add(item.id);
      continue;
    }
    const res = await resolveDerivedBacklogItem(workDir, item.id, { sha: proof.sha, subject: proof.subject, branch: cache.branch });
    if (res.ok) report.resolved.push({ id: item.id, sha: proof.sha, subject: proof.subject });
  }
}

async function run(workDir: string, now: number, force: boolean): Promise<DerivedReport> {
  const empty = (skipped: string, branch: string | null = null): DerivedReport => ({ branch, skipped, resolved: [], ignored: [], held: [], trailerCommits: 0, cached: false });
  const chosen = await integrationBranch(workDir);
  const branch = chosen.branch;
  if (!branch) return empty(chosen.skipped ?? "no integration branch");
  let state: { cache: Cache; moved: boolean };
  try {
    state = await refresh(workDir, branch, now);
  } catch (err) {
    return empty(`git could not be read: ${(err as Error).message.split("\n")[0]}`, branch);
  }
  const { cache, moved } = state;
  const report: DerivedReport = { branch, resolved: [], ignored: [], held: [], trailerCommits: cache.commits, cached: !moved };
  // The tip has not moved since the last derivation: nothing new can close, so
  // the store is not read — unless a tab's hold is waiting to be let go of.
  if (!moved && cache.pending.size === 0 && !force) return report;
  if (cache.groups.length === 0 && cache.malformed.length === 0) return report;
  await closeFixed(workDir, cache, report);
  return report;
}

/**
 * Close every open or doing item whose `Fixes-Backlog:` commit is on the
 * integration branch, and report it. Safe to call from anywhere, often: calls
 * inside `DERIVE_TTL_MS` share one answer, concurrent calls share one run, a
 * repository that has not moved costs one `rev-parse` and no backlog scan.
 * Never throws.
 */
export function deriveBacklogFromGit(workDir: string, opts: { force?: boolean; now?: number } = {}): Promise<DerivedReport> {
  const now = opts.now ?? Date.now();
  const running = inflight.get(workDir);
  if (running) return running;
  const prev = caches.get(workDir);
  const p = (async () => {
    if (!opts.force && prev && now - prev.at < DERIVE_TTL_MS && prev.pending.size === 0) {
      return { branch: prev.branch, resolved: [], ignored: [], held: [], trailerCommits: prev.commits, cached: true } satisfies DerivedReport;
    }
    try {
      return await run(workDir, now, !!opts.force);
    } catch (err) {
      return { branch: null, skipped: (err as Error).message, resolved: [], ignored: [], held: [], trailerCommits: 0, cached: false } satisfies DerivedReport;
    }
  })().finally(() => inflight.delete(workDir));
  inflight.set(workDir, p);
  return p;
}

/** Tests: forget what was scanned and reported. */
export function resetBacklogDeriveForTests(): void {
  caches.clear();
  inflight.clear();
  reported.clear();
}
