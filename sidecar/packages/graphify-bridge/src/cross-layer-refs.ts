/**
 * Cross-layer references — the half of a change's blast radius the call graph
 * cannot see (ADR-0121).
 *
 * `changeImpact` finds callers through `calls` edges. On 2026-09-28 three
 * parallel agri-saas tabs each shipped a change whose consumer had NO call edge
 * to it, and each was found only after the branch was "done":
 *
 *   - a backend enum value (`DOVADA_DEPUNERE_AUTORITATE`) that the OpenAPI
 *     spec, the generated types and the UI labels did not list;
 *   - an API route whose authorisation changed, called from a web page by a
 *     URL string (`…/ppp-professional-user`);
 *   - a config key in `garage.toml` that a restore script mounts by file name.
 *
 * Every one of those is a TEXTUAL reference: a file name, a constant, a route
 * segment. So this pass reads the diff, pulls out the distinctive tokens it
 * touched, and asks `git grep` where else in the repository they appear —
 * outside the changed files. It knows no stack, framework or project
 * (Golden Rule 6): the rules are about the shape of a token, never its name.
 *
 * It also reports a PARITY gap: a new value added next to sibling constants
 * (an enum member among others) where some file outside the branch lists the
 * siblings but not the new value — the OpenAPI enum that was never updated.
 *
 * Heuristic by design; the render says so. Its job is to put the consumer in
 * front of the reviewer, not to prove it broken.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export type RefKind = "file" | "identifier" | "path";

export interface CrossLayerRef {
  token: string;
  kind: RefKind;
  /** `file:line` locations outside the changed files, capped. */
  locations: string[];
  /** Total matching lines outside the branch (before the cap). */
  total: number;
}

export interface ParityGap {
  /** The value this branch added. */
  token: string;
  /** A file outside the branch that lists its siblings but not it. */
  file: string;
  siblings: string[];
}

export interface CrossLayerReport {
  refs: CrossLayerRef[];
  parityGaps: ParityGap[];
  /** Tokens dropped because they appear too widely to mean anything. */
  tooCommon: string[];
}

/** Files whose NAME is the contract other layers use (scripts mount them, compose files bind them). */
const NAMED_BY_OTHERS_EXT = new Set([
  ".toml", ".yml", ".yaml", ".json", ".properties", ".conf", ".ini", ".env",
  ".sh", ".bash", ".sql", ".xml", ".tf", ".hcl", ".cfg", ".service",
]);
/** Where a lowercase snake/kebab key is a config KEY rather than prose or a local variable. */
const CONFIG_EXT = new Set([
  ".toml", ".yml", ".yaml", ".properties", ".conf", ".ini", ".env", ".cfg", ".tf", ".hcl", ".service",
]);
/** A key at the start of a config line: `key = …`, `key: …`, `export KEY=…`. Prose never matches. */
const CONFIG_KEY_LINE = /^\s*(?:export\s+)?([A-Za-z][A-Za-z0-9_.-]*)\s*[:=]/;
/** Paths where a list of values is history or a sample, not a contract to keep in step. */
const PARITY_EXEMPT = /(^|\/)(migrations?|db\/migrate|alembic|versions|tests?|__tests__|fixtures?|testdata)\/|\.(test|spec)\.[a-z]+$|(^|\/)docs?\//i;
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);
const SHELL_EXT = new Set([".sh", ".bash", ".zsh"]);
const TEST_PATH = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[a-z]+$|(Test|IT)\.java$/;
/** A changed file with at most this many path segments contributes all of them (a small controller). */
const SMALL_FILE_SEGMENTS = 3;
/** Basenames too generic to be a reference to one particular file. */
const GENERIC_BASENAMES = new Set([
  "package.json", "tsconfig.json", "settings.json", "config.json", "config.yml", "config.yaml",
  "docker-compose.yml", "compose.yml", "values.yaml", "application.yml", "application.yaml",
  "pom.xml", "build.gradle", "index.json", "schema.json", "openapi.yaml", "openapi.json",
]);
/** Paths whose hits are noise: generated output, vendored code, MARVIN's own state. */
const IGNORED_PREFIXES = ["graphify-out/", ".marvin/", "node_modules/", "vendor/", "dist/", "build/", ".next/"];

const MAX_TOKENS = 80;
const MAX_LOCATIONS = 8;
/** A token matching more lines than this is a word, not a reference. */
const TOO_COMMON_LINES = 150;

const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const PATH_LITERAL = /["'`](\/[A-Za-z0-9_{}$:.\-]+(?:\/[A-Za-z0-9_{}$:.\-]+)+)["'`]/g;

interface Hunk {
  file: string;
  added: string[];
  removed: string[];
  context: string[];
}

/** Parse `git diff -U3` output into per-hunk line groups. Pure. */
export function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let file = "";
  let cur: Hunk | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = null;
      const m = / b\/(.+)$/.exec(line);
      file = m?.[1] ?? "";
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("index ")) continue;
    if (line.startsWith("@@")) {
      cur = { file, added: [], removed: [], context: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
    else if (line.startsWith(" ")) cur.context.push(line.slice(1));
  }
  return hunks;
}

function configKeys(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    const k = CONFIG_KEY_LINE.exec(l)?.[1];
    if (k && k.length >= 8 && /[_-]/.test(k)) out.add(k);
  }
  return out;
}

function tokensOf(lines: string[], re: RegExp, minLen: number): Set<string> {
  const out = new Set<string>();
  for (const l of lines) {
    for (const m of l.matchAll(re)) {
      if (m[0].length >= minLen) out.add(m[0]);
    }
  }
  return out;
}

/** Static route segments worth searching for: no parameters, distinctive. */
export function routeSegments(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH_LITERAL)) {
    for (const seg of (m[1] ?? "").split("/")) {
      if (!seg || /[{}$:]/.test(seg)) continue;
      if (seg.length >= 8 && /[-_]/.test(seg)) out.add(seg);
    }
  }
  return out;
}

export interface TokenPlan {
  /** token → kind, in priority order (Map keeps insertion order). */
  tokens: Map<string, RefKind>;
  /** Added UPPER_SNAKE values → the sibling constants around them. */
  siblingsOf: Map<string, string[]>;
  /** Constants the diff added — searched only to decide parity, never reported as refs. */
  added: Set<string>;
}

/**
 * Pure: the diff + the changed files' current text → what to search for.
 * Removed identifiers come first (a removal breaks every consumer), then
 * added ones, then file names, then route segments.
 */
export function planTokens(
  hunks: Hunk[],
  changedFiles: string[],
  readChanged: (rel: string) => string | null,
): TokenPlan {
  const removedIds = new Set<string>();
  const addedIds = new Set<string>();
  const siblingsOf = new Map<string, string[]>();

  for (const h of hunks) {
    const ext = extname(h.file).toLowerCase();
    if (DOC_EXT.has(ext)) continue;
    const isConfig = CONFIG_EXT.has(ext) || basename(h.file).startsWith(".env");
    const rem = tokensOf(h.removed, UPPER_SNAKE, 8);
    const add = tokensOf(h.added, UPPER_SNAKE, 8);
    if (isConfig) {
      for (const t of configKeys(h.removed)) rem.add(t);
      for (const t of configKeys(h.added)) add.add(t);
    }
    for (const t of rem) if (!add.has(t)) removedIds.add(t);
    for (const t of add) if (!rem.has(t)) addedIds.add(t);
    // Parity: a new constant among neighbours — an enum member, a list item.
    // Only in code and specs: shell and config files set variables, and
    // variables next to each other are not alternatives of one type.
    if (isConfig || SHELL_EXT.has(ext)) continue;
    const around = tokensOf([...h.context, ...h.added], UPPER_SNAKE, 8);
    for (const t of tokensOf(h.added, UPPER_SNAKE, 8)) {
      if (rem.has(t)) continue;
      // List-item position only: the token leads its line (after indentation,
      // quotes, a bullet or a bracket). `static final Set<X> NAME = …` declares
      // a name beside the values; it is not one of them.
      const lead = new RegExp(`^[\\s"'\`\\-\\[(,]*${t}\\b`);
      if (!h.added.some((l) => lead.test(l))) continue;
      const sib = [...around].filter((s) => s !== t && !addedIds.has(s));
      if (sib.length >= 2) siblingsOf.set(t, sib.slice(0, 12));
    }
  }

  const tokens = new Map<string, RefKind>();
  const put = (t: string, k: RefKind) => {
    if (tokens.size < MAX_TOKENS && !tokens.has(t)) tokens.set(t, k);
  };
  // A removed identifier matters only if the branch no longer has it at all —
  // one moved or re-listed elsewhere in the branch still exists for consumers.
  const branchText = changedFiles
    .filter((f) => !DOC_EXT.has(extname(f).toLowerCase()))
    .map((f) => readChanged(f) ?? "")
    .join("\n");
  for (const t of removedIds) if (!branchText.includes(t)) put(t, "identifier");
  for (const f of changedFiles) {
    const b = basename(f);
    const ext = extname(b).toLowerCase();
    if (b.length < 8 || GENERIC_BASENAMES.has(b)) continue;
    if (NAMED_BY_OTHERS_EXT.has(ext) || b === "Dockerfile" || b.startsWith(".env")) put(b, "file");
  }
  // Path segments: those on changed lines, plus every one in a small file —
  // a two-route controller whose auth changed is about both routes; a
  // forty-route one is about the lines that changed.
  const hunkSegs = new Map<string, Set<string>>();
  for (const h of hunks) {
    if (DOC_EXT.has(extname(h.file).toLowerCase())) continue;
    const set = hunkSegs.get(h.file) ?? new Set<string>();
    for (const seg of routeSegments([...h.added, ...h.removed, ...h.context].join("\n"))) set.add(seg);
    hunkSegs.set(h.file, set);
  }
  for (const f of changedFiles) {
    const ext = extname(f).toLowerCase();
    if (DOC_EXT.has(ext)) continue;
    const segs = new Set(hunkSegs.get(f) ?? []);
    const text = readChanged(f);
    if (text) {
      const all = routeSegments(text);
      if (all.size <= SMALL_FILE_SEGMENTS) for (const seg of all) segs.add(seg);
    }
    for (const seg of segs) put(seg, "path");
  }
  return { tokens, siblingsOf, added: addedIds };
}

interface GrepHit {
  file: string;
  line: string;
  text: string;
}

function ignored(file: string): boolean {
  return IGNORED_PREFIXES.some((p) => file.startsWith(p));
}

/**
 * Pure: grep hits → the report. Hits inside `changed` are the branch's own
 * business and never reported.
 */
export function buildReport(plan: TokenPlan, hits: GrepHit[], changed: Set<string>): CrossLayerReport {
  const byToken = new Map<string, GrepHit[]>();
  const filesWith = new Map<string, Set<string>>(); // token → files outside the branch
  const all = [...new Set([...plan.tokens.keys(), ...plan.siblingsOf.keys(), ...[...plan.siblingsOf.values()].flat()])];
  for (const h of hits) {
    if (changed.has(h.file) || ignored(h.file)) continue;
    // Prose names things without depending on them.
    if (DOC_EXT.has(extname(h.file).toLowerCase())) continue;
    for (const t of all) {
      if (!h.text.includes(t)) continue;
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t)?.push(h);
      if (!filesWith.has(t)) filesWith.set(t, new Set());
      filesWith.get(t)?.add(h.file);
    }
  }

  const refs: CrossLayerRef[] = [];
  const tooCommon: string[] = [];
  for (const [token, kind] of plan.tokens) {
    const found = byToken.get(token) ?? [];
    if (found.length === 0) continue;
    if (found.length > TOO_COMMON_LINES) {
      tooCommon.push(token);
      continue;
    }
    // Real consumers first: a dotfile (ignore lists, tool config) or a test
    // names a file far more often than it depends on it.
    const rank = (f: string) => (/(^|\/)\./.test(f) ? 2 : TEST_PATH.test(f) ? 1 : 0);
    const ordered = [...found].sort((a, b) => rank(a.file) - rank(b.file));
    refs.push({
      token,
      kind,
      total: found.length,
      locations: ordered.slice(0, MAX_LOCATIONS).map((h) => `${h.file}:${h.line}`),
    });
  }

  const parityGaps: ParityGap[] = [];
  for (const [token, siblings] of plan.siblingsOf) {
    const has = filesWith.get(token) ?? new Set<string>();
    const count = new Map<string, string[]>();
    for (const s of siblings) {
      for (const f of filesWith.get(s) ?? []) {
        if (!count.has(f)) count.set(f, []);
        count.get(f)?.push(s);
      }
    }
    for (const [file, present] of count) {
      if (PARITY_EXEMPT.test(file)) continue;
      if (present.length >= 2 && !has.has(file)) parityGaps.push({ token, file, siblings: present.slice(0, 4) });
    }
  }
  parityGaps.sort((a, b) => a.token.localeCompare(b.token) || a.file.localeCompare(b.file));
  return { refs, parityGaps: parityGaps.slice(0, 40), tooCommon };
}

/**
 * Git side: diff `diffBase` (a commit, or `HEAD` for an explicit file set),
 * plan the tokens, run ONE `git grep` for all of them, build the report.
 */
export async function crossLayerReferences(
  workDir: string,
  diffBase: string,
  changedFiles: string[],
): Promise<CrossLayerReport> {
  const git = async (args: string[]) =>
    (await pExecFile("git", args, { cwd: workDir, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const changed = new Set(changedFiles);
  let diff = "";
  try {
    diff = await git(["diff", "-U3", "--no-color", diffBase, "--", ...changedFiles]);
  } catch {
    diff = "";
  }
  const readChanged = (rel: string): string | null => {
    const p = join(workDir, rel);
    try {
      return existsSync(p) ? readFileSync(p, "utf-8").slice(0, 400_000) : null;
    } catch {
      return null;
    }
  };
  // Untracked files have no diff; everything in them is "added".
  const hunks = parseUnifiedDiff(diff);
  const inDiff = new Set(hunks.map((h) => h.file));
  for (const f of changedFiles) {
    if (inDiff.has(f)) continue;
    const text = readChanged(f);
    if (text) hunks.push({ file: f, added: text.split("\n"), removed: [], context: [] });
  }
  const plan = planTokens(hunks, changedFiles, readChanged);
  // Parity is about values NEW to the repository. A value that already
  // existed at the base (re-listed by a new migration, say) has had its
  // consumers all along.
  if (plan.siblingsOf.size > 0) {
    const candidates = [...plan.siblingsOf.keys()];
    const baseArgs = ["-c", "core.quotePath=false", "grep", "-h", "-o", "-I", "-F", "--no-color"];
    for (const t of candidates) baseArgs.push("-e", t);
    baseArgs.push(diffBase === "HEAD" ? "HEAD" : diffBase);
    let existed = "";
    try {
      existed = await git(baseArgs);
    } catch {
      existed = "";
    }
    const seen = new Set(existed.split("\n").map((l) => l.trim()).filter(Boolean));
    for (const t of candidates) if (seen.has(t)) plan.siblingsOf.delete(t);
  }
  const search = [...new Set([...plan.tokens.keys(), ...plan.siblingsOf.keys(), ...[...plan.siblingsOf.values()].flat()])];
  if (search.length === 0) return { refs: [], parityGaps: [], tooCommon: [] };

  const args = ["-c", "core.quotePath=false", "grep", "-n", "-I", "-F", "--no-color"];
  for (const t of search) args.push("-e", t);
  let out = "";
  try {
    out = await git(args);
  } catch (err) {
    // `git grep` exits 1 when nothing matches — that is an answer, not a failure.
    const e = err as { code?: number; stdout?: string };
    out = e.code === 1 ? "" : (e.stdout ?? "");
  }
  const hits: GrepHit[] = [];
  for (const line of out.split("\n")) {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (m?.[1] && m[2]) hits.push({ file: m[1], line: m[2], text: m[3] ?? "" });
  }
  return buildReport(plan, hits, changed);
}

/** The section appended to `graph_change_impact`'s output. */
export function renderCrossLayer(r: CrossLayerReport): string {
  const lines: string[] = [];
  lines.push(
    "",
    "Cross-layer references (TEXT matches, not calls — files OUTSIDE the branch that name something it changed:",
    "a file name, a constant or key, a path segment). A contract change must update these or say why not:",
  );
  if (r.refs.length === 0) {
    lines.push("  (none found)");
  } else {
    for (const ref of r.refs) {
      const more = ref.total > ref.locations.length ? ` … +${ref.total - ref.locations.length}` : "";
      lines.push(`  - \`${ref.token}\` (${ref.kind}) — ${ref.locations.join(", ")}${more}`);
    }
  }
  if (r.parityGaps.length) {
    lines.push(
      "",
      "Possible missing values (a file outside the branch lists the new value's siblings but NOT the new value —",
      "an enum, spec or label table that was not updated):",
    );
    for (const g of r.parityGaps) {
      lines.push(`  - \`${g.token}\` missing from ${g.file} (it lists ${g.siblings.join(", ")})`);
    }
  }
  if (r.tooCommon.length) {
    lines.push("", `Not traced (too widespread to mean one thing): ${r.tooCommon.slice(0, 12).join(", ")}`);
  }
  return lines.join("\n");
}
