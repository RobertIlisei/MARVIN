/**
 * Where MARVIN finds the graphify CLI — one resolver for every call site.
 *
 * Every spawn used to be a bare `graphify`, resolved from the sidecar's PATH.
 * A Finder / Spotlight launch hands the app launchd's minimal PATH, and
 * SidecarManager only prepends `/opt/homebrew/bin` and `/usr/local/bin`, so
 * `~/.local/bin` — where graphify's recommended install (`uv tool install
 * graphifyy`, or pipx) puts the binary — was never searched. On a machine
 * with both, MARVIN ran a stale Homebrew-pip 0.9.53 while the user's shell
 * ran 0.9.65, and the per-turn rebuild kept rewriting the graph with the
 * older version (observed 2026-09-23). On a machine with only the uv copy,
 * every graph tool and every rebuild would fail with ENOENT.
 *
 * Same shape as `discoverClaudeBinary` (ADR-0087): search the known install
 * locations plus PATH, and pick the NEWEST, not the first. `GRAPHIFY_BIN`
 * still wins outright — an explicit pin is a decision.
 */

import { execFileSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { delimiter, join } from "node:path";

export interface GraphifyBinOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** Shown wherever a graphify call fails because no binary could be found. */
export const GRAPHIFY_MISSING_HINT =
  "graphify CLI not found. Install it with `uv tool install \"graphifyy[mcp]\"` (or `pipx install \"graphifyy[mcp]\"`), " +
  "or set GRAPHIFY_BIN to its absolute path, then restart MARVIN.";

/**
 * In 0.9.118 (not in 0.9.73) `graphify query`, `explain`, `path`, `affected` and
 * `benchmark` import `graphify.serve`, which needs `anyio`, and the base install
 * does not carry it: it belongs to the `mcp` extra. Every one of them dies with a Python
 * traceback on a plain `uv tool install graphifyy`, which `graph_query`,
 * `graph_explain` and `graph_benchmark` would show as an unreadable stack.
 */
export const GRAPHIFY_EXTRAS_HINT =
  "This graphify is installed without its `mcp` extra, which query / explain / benchmark need. " +
  "Reinstall with `uv tool install --force \"graphifyy[mcp]\"` (or `pipx install --force \"graphifyy[mcp]\"`), then retry.";

/** The reinstall hint when `err` is a graphify run that died on a missing optional dependency, else null. */
export function graphifyExtrasHint(err: unknown): string | null {
  const e = err as { message?: unknown; stderr?: unknown } | null;
  const text = `${typeof e?.message === "string" ? e.message : ""}\n${typeof e?.stderr === "string" ? e.stderr : ""}`;
  return /No module named '(?:anyio|mcp|starlette)'/.test(text) ? GRAPHIFY_EXTRAS_HINT : null;
}

/** `graphify 0.9.65` → `[0, 9, 65]`; null when unreadable. */
export function graphifyVersion(bin: string): number[] | null {
  try {
    const out = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

function newer(a: number[] | null, b: number[] | null): boolean {
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every place graphify is commonly installed, de-duplicated, in search order. */
export function graphifyCandidates(opts: GraphifyBinOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const out = [
    join(home, ".local", "bin", "graphify"), // uv tool / pipx
    "/opt/homebrew/bin/graphify",
    "/usr/local/bin/graphify",
  ];
  // `pip install --user` on macOS puts scripts under ~/Library/Python/<ver>/bin.
  try {
    for (const ver of readdirSync(join(home, "Library", "Python"))) {
      out.push(join(home, "Library", "Python", ver, "bin", "graphify"));
    }
  } catch {
    // No user-site Python — nothing to add.
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) out.push(join(dir, "graphify"));
  }
  return [...new Set(out)];
}

let cached: string | null = null;

/**
 * The graphify binary to spawn. Falls back to bare `graphify` when nothing is
 * found, so the spawn fails with ENOENT and the caller can show
 * {@link GRAPHIFY_MISSING_HINT}. The fallback is never cached: installing
 * graphify while MARVIN runs is picked up on the next call.
 */
export function resolveGraphifyBin(opts: GraphifyBinOptions = {}): string {
  const env = opts.env ?? process.env;
  const override = env.GRAPHIFY_BIN?.trim();
  if (override) return override;

  const useCache = opts.env === undefined && opts.home === undefined;
  if (useCache && cached && isExecutable(cached)) return cached;

  let best: string | null = null;
  let bestVersion: number[] | null = null;
  for (const p of graphifyCandidates(opts)) {
    if (!isExecutable(p)) continue;
    const v = graphifyVersion(p);
    // First existing candidate wins until something provably newer appears,
    // so an unreadable --version never beats a known-good binary.
    if (best === null || newer(v, bestVersion)) {
      best = p;
      bestVersion = v;
    }
  }
  if (best && useCache) cached = best;
  return best ?? "graphify";
}

/**
 * The Python interpreter that has the `graphify` package — read from the
 * resolved CLI's shebang. The knowledge-graph builder imports graphify as a
 * library, and a uv / pipx install keeps it in a private venv the system
 * `python3` cannot import from: the builder exited 2 on every turn and the
 * knowledge graph silently went stale (observed 2026-09-29). Falls back to
 * `python3` when the CLI is missing or is not a Python script.
 */
export function graphifyPython(opts: GraphifyBinOptions = {}): string {
  const bin = resolveGraphifyBin(opts);
  try {
    const firstLine = readFileSync(bin, "utf-8").split("\n", 1)[0] ?? "";
    const m = firstLine.match(/^#!\s*(\S*python[\d.]*)\s*$/);
    if (m?.[1] && isExecutable(m[1])) return m[1];
  } catch {
    // Unreadable or bare `graphify` fallback — use the system interpreter.
  }
  return "python3";
}

/**
 * The environment for every graphify MARVIN spawns. graphify 0.9.72 refreshes
 * its installed skill files (`~/.claude/skills/graphify`, `~/.agents/skills`)
 * on any non-install command when they are stale — and MARVIN runs graphify in
 * the background on every turn. A skill update is the Skills pane's job
 * (ADR-0071), never a side effect of a graph refresh. The user's own
 * `graphify` in a terminal is unaffected and still refreshes. It also caps the
 * extraction workers ({@link graphifyMaxWorkers}).
 */
export function graphifyEnv(
  base: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, GRAPHIFY_NO_AUTO_REFRESH: "1" };
  if (!env.GRAPHIFY_MAX_WORKERS?.trim()) env.GRAPHIFY_MAX_WORKERS = String(graphifyMaxWorkers(cpus));
  return env;
}

/**
 * Extraction workers for a graphify MARVIN spawns. graphify defaults to one
 * worker per core (up to the file count), so a per-turn `update` on a large
 * project held ~14 of 18 cores for the whole run, once per tab (measured
 * 2026-11-24). A background refresh should leave the machine to the user's
 * builds: half the cores, never fewer than 2 or more than 6. An explicit
 * `GRAPHIFY_MAX_WORKERS` in the sidecar's environment still wins.
 */
export function graphifyMaxWorkers(cpus: number): number {
  return Math.max(2, Math.min(6, Math.floor(cpus / 2)));
}

/**
 * The oldest graphify MARVIN's graph tools are correct on. Below 0.9.68 an
 * incremental `graphify update` — the per-turn watchdog's command — dropped
 * cross-file `calls` / `imports` edges into unchanged files, which are the
 * edges `graph_affected` and `graph_change_impact` read.
 */
export const GRAPHIFY_MIN_VERSION: readonly number[] = [0, 9, 68];

/** True when `version` is known and older than {@link GRAPHIFY_MIN_VERSION}. */
export function graphifyBelowMinimum(version: number[] | null): boolean {
  return version !== null && newer([...GRAPHIFY_MIN_VERSION], version);
}

/** The install hint when `err` is a spawn that found no binary, else null. */
export function graphifyMissingHint(err: unknown): string | null {
  return (err as { code?: unknown } | null)?.code === "ENOENT" ? GRAPHIFY_MISSING_HINT : null;
}
