import { existsSync, statSync } from "node:fs";

import { loadGraphNodes } from "./read-graph";

/**
 * Project areas, discovered from the project's own graph (2026-09-07).
 *
 * The tracer-bullet rule (personality Phase 5, practice `plan.horizontal`)
 * needs to know whether a milestone crosses "layers". MARVIN ships no notion
 * of what a layer is — no tech-stack vocabulary, no directory conventions —
 * because every project it works on is someone else's. So the layers are
 * read off the project: its code files, grouped by directory and split
 * wherever a directory holds two or more substantial groups, become its
 * *areas* (`apps/api`, `apps/web`, `infrastructure`; or `macos`, `sidecar`),
 * and each area's vocabulary is its own directory names and file stems —
 * kept only where a token is distinctive to that area. A
 * milestone title that hits two areas crosses layers. A project with no
 * graph, or fewer than two areas, has no layers to cross and yields nothing.
 */

export interface ProjectArea {
  /** Directory prefix relative to the project's common root, e.g. `apps/api`. */
  name: string;
  files: number;
  /** Stemmed, lower-case tokens distinctive to this area (directory names and file stems). */
  vocab: string[];
  /** The structural subset: tokens from directory names and the area's own
   *  unique name segments. What a project calls its parts (`migrations/`,
   *  `pages/`), as opposed to what it calls its things (file stems carry
   *  domain nouns that any layer's step may mention). */
  structural: string[];
}

export interface ProjectAreas {
  areas: ProjectArea[];
  fileCount: number;
}

/** Deepest directory level an area name may have. */
export const AREA_MAX_DEPTH = 3;
/** A child directory counts when it holds at least this many files … */
export const AREA_MIN_FILES = 3;
/** … and at least this share of its parent's files. */
export const AREA_MIN_SHARE = 0.05;
/** A token belongs to an area's vocabulary when this share of its occurrences
 *  are there, AND that share beats the area's share of all files by
 *  `VOCAB_LIFT` — otherwise an area holding most of the project owns every
 *  word … */
export const VOCAB_DISTINCT_SHARE = 0.6;
export const VOCAB_LIFT = 0.2;
/** … and it occurs at least this often. */
export const VOCAB_MIN_COUNT = 2;
const VOCAB_MIN_LEN = 4;
/** Directories that are tooling or tests, not layers — folded into their
 *  parent. Universal conventions (dot-directories, test folders), not any
 *  stack's. */
const NOT_A_LAYER = /^(?:\..*|tests?|__tests__|specs?|e2e|fixtures?|__mocks__)$/i;

/** Camel-split, lower-case, alphanumeric tokens of at least three characters
 *  (a plural is folded onto its singular so `migrations/` meets "migration"). */
export function tokensOf(text: string): string[] {
  const split = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out: string[] = [];
  for (const raw of split.split(/[^A-Za-z0-9]+/)) {
    const t = stem(raw.toLowerCase());
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

interface FileEntry {
  /** Directory segments relative to the common root. */
  dirs: string[];
  stem: string;
  labels: string[];
}

function collectFiles(graphPath: string): FileEntry[] {
  const byFile = new Map<string, string[]>();
  for (const n of loadGraphNodes(graphPath)) {
    if (!n.source_file) continue;
    if (n.file_type && n.file_type !== "code") continue;
    const file = n.source_file.replace(/\\/g, "/");
    const labels = byFile.get(file) ?? [];
    if (n.label) labels.push(n.label);
    byFile.set(file, labels);
  }
  const files = [...byFile.keys()];
  if (files.length === 0) return [];
  // Longest common directory prefix — graphify writes absolute paths on a real
  // run, repo-relative ones elsewhere; either way the project root is not an
  // area.
  const dirsOf = (f: string) => f.split("/").slice(0, -1).filter((s) => s.length > 0);
  let common = dirsOf(files[0]!);
  for (const f of files.slice(1)) {
    const d = dirsOf(f);
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i += 1;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  return files.map((f) => {
    const base = f.split("/").pop() ?? f;
    return {
      dirs: dirsOf(f).slice(common.length),
      stem: base.replace(/\.[^.]+$/, ""),
      labels: byFile.get(f) ?? [],
    };
  });
}

/** Split `files` (all under the directory named by `prefix`) into areas. */
function areasUnder(prefix: string[], files: FileEntry[], depth: number): Array<{ name: string; files: FileEntry[] }> {
  const groups = new Map<string, FileEntry[]>();
  for (const f of files) {
    const seg = f.dirs[depth];
    if (seg === undefined || NOT_A_LAYER.test(seg)) continue; // sits here, or is tooling/tests
    const g = groups.get(seg) ?? [];
    g.push(f);
    groups.set(seg, g);
  }
  const min = Math.max(AREA_MIN_FILES, Math.ceil(files.length * AREA_MIN_SHARE));
  const substantial = [...groups.entries()].filter(([, g]) => g.length >= min).sort((a, b) => a[0].localeCompare(b[0]));
  const child = (seg: string, g: FileEntry[]) => {
    const name = [...prefix, seg];
    const sub = name.length < AREA_MAX_DEPTH ? areasUnder(name, g, depth + 1) : [];
    return sub.length >= 2 ? sub : [{ name: name.join("/"), files: g }];
  };
  if (substantial.length >= 2) return substantial.flatMap(([seg, g]) => child(seg, g));
  // One substantial child (`src/`): the split, if any, is below it.
  if (substantial.length === 1 && prefix.length + 1 < AREA_MAX_DEPTH) {
    const [seg, g] = substantial[0]!;
    return areasUnder([...prefix, seg], g, depth + 1);
  }
  return [];
}

function buildVocab(areas: Array<{ name: string; files: FileEntry[] }>): ProjectArea[] {
  const perArea = areas.map(() => new Map<string, number>());
  const total = new Map<string, number>();
  const dirTokens = areas.map(() => new Set<string>());
  const bump = (i: number, t: string) => {
    perArea[i]!.set(t, (perArea[i]!.get(t) ?? 0) + 1);
    total.set(t, (total.get(t) ?? 0) + 1);
  };
  // Paths only — directory names and file stems are how a project names its
  // parts. Symbol labels were tried and flood an area with ordinary English
  // ("about", "after", "run"); a title names a file far more reliably.
  areas.forEach((a, i) => {
    const own = a.name.split("/").length;
    for (const f of a.files) {
      const seen = new Set<string>();
      for (const seg of f.dirs.slice(own)) {
        for (const t of tokensOf(seg)) {
          seen.add(t);
          dirTokens[i]!.add(t);
        }
      }
      for (const t of tokensOf(f.stem)) seen.add(t);
      for (const t of seen) bump(i, t);
    }
  });
  const allFiles = areas.reduce((n, a) => n + a.files.length, 0);
  // An area's own path segments identify it — unless siblings share them
  // (`sidecar/packages/runtime` and `sidecar/packages/tools` both say
  // "sidecar"; that word names their parent, not either of them).
  const nameTokenOwners = new Map<string, number>();
  for (const a of areas) {
    for (const t of new Set(a.name.split("/").flatMap((seg) => tokensOf(seg)))) {
      nameTokenOwners.set(t, (nameTokenOwners.get(t) ?? 0) + 1);
    }
  }
  return areas.map((a, i) => {
    const vocab = new Set<string>();
    const structural = new Set<string>();
    for (const seg of a.name.split("/")) {
      for (const t of tokensOf(seg)) {
        if (nameTokenOwners.get(t) !== 1) continue;
        vocab.add(t);
        structural.add(t);
      }
    }
    const base = a.files.length / Math.max(1, allFiles);
    for (const [t, n] of perArea[i]!) {
      if (t.length < VOCAB_MIN_LEN || n < VOCAB_MIN_COUNT) continue;
      const share = n / (total.get(t) ?? n);
      if (share < VOCAB_DISTINCT_SHARE || share < base + VOCAB_LIFT) continue;
      vocab.add(t);
      if (dirTokens[i]!.has(t)) structural.add(t);
    }
    return { name: a.name, files: a.files.length, vocab: [...vocab].sort(), structural: [...structural].sort() };
  });
}

const cache = new Map<string, { mtimeMs: number; areas: ProjectAreas | null }>();

/** Areas of the project whose code graph is at `graphPath`; null when there
 *  is no graph or fewer than two areas. Cached by the graph's mtime. */
export function discoverAreas(graphPath: string): ProjectAreas | null {
  if (!existsSync(graphPath)) return null;
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(graphPath).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(graphPath);
  if (hit && hit.mtimeMs === mtimeMs) return hit.areas;
  const files = collectFiles(graphPath);
  const split = areasUnder([], files, 0);
  const areas = split.length >= 2 ? { areas: buildVocab(split), fileCount: files.length } : null;
  cache.set(graphPath, { mtimeMs, areas });
  return areas;
}

/** Areas a milestone title touches: by naming an area's path, or by any
 *  token distinctive to it — only structural tokens when `structural` is
 *  set. Order follows `areas`. */
export function areasOfTitle(areas: ProjectAreas, title: string, opts: { structural?: boolean } = {}): string[] {
  const lower = title.toLowerCase();
  const tokens = new Set(tokensOf(title));
  const out: string[] = [];
  for (const a of areas.areas) {
    const words = opts.structural ? a.structural : a.vocab;
    if (lower.includes(a.name.toLowerCase()) || words.some((t) => tokens.has(t))) out.push(a.name);
  }
  return out;
}
