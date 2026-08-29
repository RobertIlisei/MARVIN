/**
 * Change impact — the blast radius of a DIFF, not of one symbol.
 *
 * ## Why this exists
 *
 * graphify's own PR tooling (`graphify prs`, `list_prs` / `get_pr_impact` /
 * `triage_prs`) is the vendor's flagship review feature — "which nodes does
 * this PR touch, where do PRs overlap" — and it is GitHub-only: every call
 * shells out to `gh`. The project MARVIN is working on lives on GitLab, so
 * none of it applies. Every piece it needs is already here, though:
 *
 *   - `git diff` names the changed files;
 *   - `graph.json` maps a file to the symbols defined in it (`source_file`)
 *     and the community each belongs to;
 *   - the AST call cache (`call-index.ts`) says who CALLS each of those
 *     symbols, directed, with file and line — which is the part the
 *     undirected graph cannot answer and the part a reviewer actually wants.
 *
 * So this is forge-agnostic by construction: it reads git and the graph, never
 * a PR API. It is the aggregate counterpart of `graph_affected` — that tool
 * answers "who calls X" for one symbol you are about to edit; this one answers
 * "what does everything on this branch reach" for Phase 3 impact analysis and
 * the pre-landing review.
 *
 * ## What it deliberately does not do
 *
 * Overlap between several open MRs (the vendor's `--conflicts`) needs the
 * forge API and a second diff per MR. Not built: one branch at a time is the
 * observed workflow, and a feature nobody asked for is a feature nobody
 * verifies.
 */

import { execFile } from "node:child_process";
import { basename, isAbsolute, relative } from "node:path";
import { promisify } from "node:util";

import {
  type CallIndex,
  callersOf,
  symbolOf,
} from "./call-index";
import { type GraphNode, loadGraphNodes, nodeLabelResolver, summarizeGraph } from "./read-graph";

const pExecFile = promisify(execFile);

export interface ExternalCaller {
  /** Symbol on the branch that is being called. */
  callee: string;
  /** Caller label (graph node label, or its id when unlabelled). */
  label: string;
  /** Caller file, repo-relative. */
  file: string;
  lines: string[];
}

export interface ChangeImpact {
  changedFiles: string[];
  /** Changed files with no node in the graph — not code, or not yet indexed. */
  unindexed: string[];
  /** Code symbols defined in the changed files. */
  changedSymbols: number;
  /** Symbols skipped because their name is too common to trace (`parse`, `get`). */
  ambiguous: string[];
  /** Callers OUTSIDE the changed files — the blast radius that leaves the branch. */
  externalCallers: ExternalCaller[];
  /** Distinct call sites inside the changed set (churn the branch already owns). */
  internalCallSites: number;
  /** Communities the branch touches, most-touched first. */
  communities: Array<{ id: number; name: string | null; symbols: number }>;
  /** God nodes (structural spine) among the changed symbols. Handle with care. */
  godNodesTouched: string[];
}

/** Per-symbol cap on callers — keeps one hot symbol from drowning the rest. */
const CALLERS_PER_SYMBOL = 40;

function toRel(workDir: string, file: string): string {
  return isAbsolute(file) ? relative(workDir, file) : file;
}

/**
 * graphify mints one node per FILE (label = the file's basename) alongside
 * the symbols defined in it. Nothing calls a file, and counting it as a
 * member of its community would inflate every count by one per file.
 */
function isFileNode(n: GraphNode): boolean {
  if (!n.label || !n.source_file) return false;
  return n.label === basename(n.source_file);
}

/** The callee-side name of a symbol node: `Foo.bar()` → `bar`. */
function calleeName(n: GraphNode): string {
  const s = symbolOf(n.label ?? n.id);
  const dot = s.lastIndexOf(".");
  return dot >= 0 ? s.slice(dot + 1) : s;
}

/**
 * Nodes whose `source_file` names one of `changedRel`. graphify writes
 * `source_file` as it scanned it — absolute on some runs, repo-relative on
 * others — so both spellings are matched.
 */
function nodesInFiles(
  nodes: GraphNode[],
  workDir: string,
  changedRel: Set<string>,
): GraphNode[] {
  const out: GraphNode[] = [];
  for (const n of nodes) {
    if (!n.source_file) continue;
    if ((n.file_type ?? "code") !== "code") continue;
    const rel = toRel(workDir, n.source_file);
    if (changedRel.has(rel)) out.push(n);
  }
  return out;
}

/**
 * Pure: graph + call index + a list of changed files → the report. Exported
 * separately from the git side so it is testable against fixtures.
 */
export function changeImpact(args: {
  workDir: string;
  graphPath: string;
  index: CallIndex;
  files: string[];
}): ChangeImpact {
  const { workDir, graphPath, index } = args;
  const changedRel = new Set(args.files.map((f) => toRel(workDir, f)));
  const nodes = loadGraphNodes(graphPath);
  const inFiles = nodesInFiles(nodes, workDir, changedRel);
  // `unindexed` is judged on ANY node (a file node proves the graph saw the
  // file); everything below is judged on symbol nodes only.
  const indexedFiles = new Set(inFiles.map((n) => toRel(workDir, n.source_file ?? "")));
  const changed = inFiles.filter((n) => !isFileNode(n));
  const unindexed = [...changedRel].filter((f) => !indexedFiles.has(f)).sort();

  // The call index knows callers only by cache id; resolve to graph labels
  // through the suffix-tolerant resolver (see read-graph.ts for why exact
  // lookup finds nothing on real repos).
  const resolveLabel = nodeLabelResolver(graphPath);

  const external = new Map<string, ExternalCaller>();
  const ambiguous: string[] = [];
  let internalSites = 0;
  const seenSymbols = new Set<string>();

  for (const n of changed) {
    const symbol = calleeName(n);
    if (!symbol) continue;
    if (seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);

    const result = callersOf(index, symbol, 1, resolveLabel);
    if (result.ambiguous) {
      ambiguous.push(symbol);
      continue;
    }
    let perSymbol = 0;
    for (const c of result.callers) {
      const callerRel = toRel(workDir, c.sourceFile);
      if (changedRel.has(callerRel)) {
        internalSites += c.lines.length || 1;
        continue;
      }
      if (perSymbol >= CALLERS_PER_SYMBOL) break;
      perSymbol += 1;
      const label = callerLabel(resolveLabel(c.callerNid), c.callerNid);
      const key = `${symbol}|${label}|${callerRel}`;
      const existing = external.get(key);
      if (existing) {
        for (const l of c.lines) if (!existing.lines.includes(l)) existing.lines.push(l);
      } else {
        external.set(key, { callee: symbol, label, file: callerRel, lines: [...c.lines] });
      }
    }
  }

  const byCommunity = new Map<number, { id: number; name: string | null; symbols: number }>();
  for (const n of changed) {
    if (typeof n.community !== "number") continue;
    const entry = byCommunity.get(n.community) ?? {
      id: n.community,
      name: realName(n.community_name),
      symbols: 0,
    };
    entry.symbols += 1;
    if (!entry.name) entry.name = realName(n.community_name);
    byCommunity.set(n.community, entry);
  }

  const summary = summarizeGraph(graphPath);
  const godIds = new Set(summary.godNodes.map((g) => g.id));
  const godNodesTouched = changed
    .filter((n) => godIds.has(n.id))
    .map((n) => n.label ?? n.id);

  return {
    changedFiles: [...changedRel].sort(),
    unindexed,
    changedSymbols: changed.length,
    ambiguous: ambiguous.sort(),
    externalCallers: [...external.values()].sort(
      (a, b) => a.callee.localeCompare(b.callee) || a.file.localeCompare(b.file),
    ),
    internalCallSites: internalSites,
    communities: [...byCommunity.values()].sort((a, b) => b.symbols - a.symbols),
    godNodesTouched,
  };
}

/**
 * A readable caller name when the graph has no label for the caller's node
 * id. graphify's cache ids are `<file>_<class>_<member>` lowercased — on a
 * real repo (agri, 2026-08-29) NONE of them matched a graph.json id, so
 * `graph_affected` prints ids like
 * `tenanterasureservice_tenanterasureservice_lockouttenant`. The last segment
 * is the member name; with the file already on the line, that is enough.
 */
function callerLabel(label: string | undefined, nid: string): string {
  if (label) return label;
  const last = nid.split("_").filter(Boolean).pop();
  return last ? `${last}()` : nid;
}

function realName(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  return !t || /^community\s+\d+$/i.test(t) ? null : t;
}

/**
 * Files changed on the current branch relative to `base`, INCLUDING the
 * working tree and untracked files — a pre-landing review looks at what will
 * ship, not only at what is committed. Diffs from the merge base so a stale
 * base branch does not report its own commits as the branch's changes.
 */
export async function changedFilesOnBranch(
  workDir: string,
  base?: string,
): Promise<{ base: string; files: string[] }> {
  const git = async (args: string[]) =>
    (await pExecFile("git", args, { cwd: workDir, timeout: 15_000 })).stdout.trim();

  let resolvedBase = base?.trim() || "";
  if (!resolvedBase) {
    try {
      resolvedBase = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    } catch {
      resolvedBase = "";
    }
  }
  if (!resolvedBase) {
    for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
      try {
        await git(["rev-parse", "--verify", "--quiet", candidate]);
        resolvedBase = candidate;
        break;
      } catch {
        /* try the next */
      }
    }
  }
  if (!resolvedBase) {
    throw new Error("could not resolve a base branch — pass `base` (e.g. \"origin/main\")");
  }

  const mergeBase = await git(["merge-base", resolvedBase, "HEAD"]);
  const tracked = await git(["diff", "--name-only", mergeBase]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  const files = new Set<string>();
  for (const line of `${tracked}\n${untracked}`.split("\n")) {
    const f = line.trim();
    if (f) files.add(f);
  }
  return { base: resolvedBase, files: [...files].sort() };
}

/** Text the tool returns — one block, reviewer's reading order. */
export function renderChangeImpact(r: ChangeImpact, opts: { base?: string; limit: number }): string {
  const lines: string[] = [];
  const head = opts.base ? `Branch vs ${opts.base}` : "Changed files";
  lines.push(
    `${head}: ${r.changedFiles.length} file(s), ${r.changedSymbols} code symbol(s), ` +
      `${r.externalCallers.length} external caller(s), ${r.internalCallSites} internal call site(s).`,
  );

  if (r.godNodesTouched.length) {
    lines.push(
      "",
      `GOD NODES TOUCHED (structural spine — widest coupling in the repo): ${r.godNodesTouched.join(", ")}`,
    );
  }

  if (r.communities.length) {
    lines.push("", "Communities touched:");
    for (const c of r.communities.slice(0, 12)) {
      lines.push(`  - ${c.name ?? `community ${c.id}`} — ${c.symbols} symbol(s)`);
    }
  }

  lines.push("", "External callers (code OUTSIDE the branch that reaches into it — review these first):");
  if (r.externalCallers.length === 0) {
    lines.push("  (none found — the branch's symbols are not called from unchanged code, or are reached dynamically)");
  } else {
    const shown = r.externalCallers.slice(0, opts.limit);
    let current = "";
    for (const c of shown) {
      if (c.callee !== current) {
        current = c.callee;
        lines.push(`  ${c.callee}:`);
      }
      const ordered = [...c.lines].sort(
        (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
      );
      const where = ordered.length ? `:${ordered.join(",")}` : "";
      lines.push(`    - ${c.label} — ${c.file}${where}`);
    }
    if (r.externalCallers.length > shown.length) {
      lines.push(`  … ${r.externalCallers.length - shown.length} more (raise \`limit\`)`);
    }
  }

  if (r.ambiguous.length) {
    lines.push(
      "",
      `Not traced (name too common to mean anything): ${r.ambiguous.join(", ")} — ` +
        "use graph_affected with a scoped grep if one of these matters.",
    );
  }
  if (r.unindexed.length) {
    lines.push(
      "",
      `Changed but not in the graph (${r.unindexed.length}): ${r.unindexed.slice(0, 15).join(", ")}` +
        (r.unindexed.length > 15 ? ", …" : "") +
        " — docs/config, or code the graph has not indexed yet (`/graphify . --update`).",
    );
  }
  return lines.join("\n");
}
