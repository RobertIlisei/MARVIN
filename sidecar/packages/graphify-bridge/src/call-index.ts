/**
 * A DIRECTED call index, reconstructed from graphify's per-file extraction
 * cache — the thing `graph.json` cannot give us.
 *
 * ## Why this exists
 *
 * MARVIN's Golden Rule 7 names "blast-radius" questions as a graph trigger:
 * *if I change X, what breaks?* Answering it needs edge DIRECTION — callers of
 * X, not neighbours of X. `graphify-out/graph.json` cannot answer it, and the
 * reason is not a missing feature:
 *
 *   - The built graph carries `directed: false`. networkx's undirected
 *     `node_link_data` emits each edge in whatever order adjacency iteration
 *     happens to produce, so `source`/`target` in `links` is an artifact of
 *     node insertion order, not semantics.
 *   - Measured on this repo (2026-08-15): `graphPathForScope --calls-->
 *     buildProjectContext` and `sdk_runner_runAgent --calls-->
 *     createGraphMcpServer` appear with the SAME relation in OPPOSITE
 *     orientations, though both describe a caller/callee pair. Orientation is
 *     noise.
 *   - graphify 0.9.43's `affected` subcommand reverse-traverses that graph, so
 *     on an undirected build it returns a neighbourhood walk wearing a
 *     blast-radius label. `--directed` is not a build flag in 0.9.43 — it
 *     exists only on `diagnose multigraph`, as a post-build simulation toggle.
 *
 * What IS directed and durable is `graphify-out/cache/<hash>.json`, which the
 * AST pass writes per source file. Each holds `raw_calls`, an explicit
 * `caller_nid → callee` list with file and line. 28,930 call edges across 1,302
 * cache files on this repo, indexed in ~0.2 s. That is the honest substrate.
 *
 * ## What this is NOT
 *
 * The caller side is exact — a node id, file and line from the AST. The callee
 * side is a bare SYMBOL NAME, unresolved: `parse`, `trim`, `readFile`. So a
 * lookup is name-matched, and a common name over-matches wildly (`trim` has 580
 * call sites here, from every unrelated `.trim()` in the repo). Callers of a
 * distinctive symbol are trustworthy; callers of a generic one are a starting
 * point. `callersOf` reports that ambiguity rather than hiding it — a tool that
 * silently conflates 580 unrelated call sites is worse than no tool.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** One AST-observed call site. The caller side is exact. */
export interface CallSite {
  /** graphify node id of the enclosing function//method that makes the call. */
  callerNid: string;
  /** Absolute path of the file containing the call. */
  sourceFile: string;
  /** graphify's location string, e.g. "L162". */
  sourceLocation: string;
}

export interface CallIndex {
  /** callee symbol name → every call site that names it. */
  byCallee: Map<string, CallSite[]>;
  /** Total call edges retained after staleness filtering. */
  edges: number;
  /** Call sites dropped because their source file no longer exists. */
  stale: number;
  /** Cache files read. */
  files: number;
}

const EMPTY: CallIndex = { byCallee: new Map(), edges: 0, stale: 0, files: 0 };

export function cacheDirFor(workDir: string): string {
  return join(workDir, "graphify-out", "cache");
}

/**
 * Interning pool for the two strings that repeat across hundreds of thousands
 * of call sites: the source path and the caller node id.
 *
 * `JSON.parse` mints a fresh string for every occurrence, so a 433k-edge index
 * held ~433k copies of ~8.5k distinct paths. Measured on a real Spring Boot
 * project: interning is the difference between an index that is merely large
 * and one that is a liability in a long-running sidecar.
 */
function intern(pool: Map<string, string>, value: string): string {
  const hit = pool.get(value);
  if (hit !== undefined) return hit;
  pool.set(value, value);
  return value;
}

interface MemoEntry {
  /** Cache filenames already folded into `index`. */
  ingested: Set<string>;
  index: CallIndex;
  /** Interning pools, kept alive so incremental additions share the strings. */
  paths: Map<string, string>;
  nids: Map<string, string>;
  /** Source-file existence, cached across incremental passes. */
  alive: Map<string, boolean>;
}

/**
 * ONE project at a time.
 *
 * A full index of a large project costs ~127 MB before interning. MARVIN
 * switches the active project freely, and a Map keyed by workDir would retain
 * every project ever queried for the life of the sidecar. Only the current
 * project's index is worth keeping.
 */
let memo: (MemoEntry & { workDir: string }) | null = null;

/**
 * Build (or return a memoised) directed call index for a project.
 *
 * Stale call sites are dropped by checking that the source file still exists.
 * This matters: the cache is content-addressed and never garbage-collected, so
 * it accumulates entries from previous repo layouts — this repo's cache still
 * held `apps/web/src/app/api/chat/route.ts` call sites long after that tree was
 * renamed to `sidecar/`. Reporting those as live callers would send MARVIN to
 * read a file that isn't there.
 */
export function buildCallIndex(workDir: string): CallIndex {
  const dir = cacheDirFor(workDir);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return EMPTY;
  }
  if (names.length === 0) return EMPTY;

  // INCREMENTAL. graphify's cache is content-addressed: an entry is never
  // rewritten in place — a changed source file produces a NEW hash filename.
  // So the only work a refresh creates is the files we have not read yet.
  //
  // This is what makes the tool usable on a large project under MARVIN's
  // per-turn watchdog: a full parse of a real Spring Boot cache is ~3 s and
  // 321 MB of I/O, and the watchdog runs `graphify update` EVERY turn, which
  // would otherwise force that full parse again on the next query.
  let entry: MemoEntry;
  if (memo && memo.workDir === workDir) {
    // Entries only ever appear. If one vanished, the cache was pruned or
    // rebuilt and our accumulated index may hold call sites that no longer
    // exist — the one case that needs a clean rebuild.
    const present = new Set(names);
    let pruned = false;
    for (const seen of memo.ingested) {
      if (!present.has(seen)) {
        pruned = true;
        break;
      }
    }
    entry = pruned ? freshEntry(workDir) : memo;
  } else {
    entry = freshEntry(workDir);
  }

  const { index, paths, nids, alive } = entry;
  for (const name of names) {
    if (entry.ingested.has(name)) continue;
    entry.ingested.add(name);
    let parsed: { raw_calls?: unknown };
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as {
        raw_calls?: unknown;
      };
    } catch {
      // A truncated cache entry (interrupted extraction) must not take the
      // whole index down — skip it and keep the rest.
      continue;
    }
    index.files += 1;
    const raw = parsed.raw_calls;
    if (!Array.isArray(raw)) continue;
    for (const rawEntry of raw) {
      const rc = rawEntry as Record<string, unknown>;
      const callee = typeof rc.callee === "string" ? rc.callee : "";
      const callerNid = typeof rc.caller_nid === "string" ? rc.caller_nid : "";
      const sourceFile = typeof rc.source_file === "string" ? rc.source_file : "";
      if (!callee || !callerNid || !sourceFile) continue;

      // Existence is checked once per distinct file, not once per call site —
      // 433k call sites collapse to ~8.5k files, and existsSync is the hot cost.
      let ok = alive.get(sourceFile);
      if (ok === undefined) {
        ok = existsSync(sourceFile);
        alive.set(sourceFile, ok);
      }
      if (!ok) {
        index.stale += 1;
        continue;
      }
      const site: CallSite = {
        callerNid: intern(nids, callerNid),
        sourceFile: intern(paths, sourceFile),
        sourceLocation:
          typeof rc.source_location === "string" ? rc.source_location : "",
      };
      const list = index.byCallee.get(callee);
      if (list) list.push(site);
      else index.byCallee.set(callee, [site]);
      index.edges += 1;
    }
  }

  memo = { ...entry, workDir };
  return index;
}

function freshEntry(_workDir: string): MemoEntry {
  return {
    ingested: new Set(),
    index: { byCallee: new Map(), edges: 0, stale: 0, files: 0 },
    paths: new Map(),
    nids: new Map(),
    alive: new Map(),
  };
}

/**
 * Above this many call sites for one name, the result is dominated by
 * unrelated symbols that merely share it (`trim`, `parse`, `get`) and should be
 * presented as a warning rather than an answer.
 */
export const AMBIGUITY_THRESHOLD = 40;

export interface AffectedCaller {
  callerNid: string;
  sourceFile: string;
  lines: string[];
  /** How many hops back from the queried symbol (1 = direct caller). */
  depth: number;
}

export interface AffectedResult {
  symbol: string;
  callers: AffectedCaller[];
  /** Distinct call sites matched at depth 1. */
  directSites: number;
  /** True when the name is too common for the result to mean much. */
  ambiguous: boolean;
  index: CallIndex;
}

/**
 * Strip graphify's label decoration so a node label round-trips to the symbol
 * name the callee side uses: "startScheduledTurn()" → "startScheduledTurn".
 */
export function symbolOf(label: string): string {
  return label.replace(/\(\)$/, "").trim();
}

/**
 * Reverse traversal: who calls `symbol`, and who calls them.
 *
 * `nidToSymbol` maps a caller node id back to a symbol name so depth > 1 can
 * continue the walk; without it the traversal stops at depth 1. Supplied by the
 * caller from graph.json rather than derived here, so this module stays a pure
 * reader of the cache.
 */
export function callersOf(
  index: CallIndex,
  symbol: string,
  depth = 1,
  nidToSymbol?: (nid: string) => string | undefined,
): AffectedResult {
  const target = symbolOf(symbol);
  const direct = index.byCallee.get(target) ?? [];
  const ambiguous = direct.length > AMBIGUITY_THRESHOLD;

  // nid → merged caller record, so a function calling X five times is one
  // result with five lines rather than five near-identical rows.
  const found = new Map<string, AffectedCaller>();
  const seenNid = new Set<string>();

  const absorb = (sites: CallSite[], atDepth: number) => {
    for (const s of sites) {
      const key = `${s.callerNid}|${s.sourceFile}`;
      const existing = found.get(key);
      if (existing) {
        if (s.sourceLocation && !existing.lines.includes(s.sourceLocation)) {
          existing.lines.push(s.sourceLocation);
        }
        continue;
      }
      found.set(key, {
        callerNid: s.callerNid,
        sourceFile: s.sourceFile,
        lines: s.sourceLocation ? [s.sourceLocation] : [],
        depth: atDepth,
      });
    }
  };

  absorb(direct, 1);
  direct.forEach((s) => seenNid.add(s.callerNid));

  // Widening the walk on an already-ambiguous name multiplies the noise
  // instead of adding signal, so depth > 1 is skipped there.
  if (depth > 1 && nidToSymbol && !ambiguous) {
    let frontier = [...seenNid];
    for (let d = 2; d <= depth; d += 1) {
      const next: string[] = [];
      for (const nid of frontier) {
        const sym = nidToSymbol(nid);
        if (!sym) continue;
        const sites = index.byCallee.get(symbolOf(sym)) ?? [];
        if (sites.length > AMBIGUITY_THRESHOLD) continue;
        absorb(sites, d);
        for (const s of sites) {
          if (!seenNid.has(s.callerNid)) {
            seenNid.add(s.callerNid);
            next.push(s.callerNid);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
  }

  const callers = [...found.values()].sort(
    (a, b) => a.depth - b.depth || a.sourceFile.localeCompare(b.sourceFile),
  );
  return {
    symbol: target,
    callers,
    directSites: direct.length,
    ambiguous,
    index,
  };
}
