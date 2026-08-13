/**
 * CI status as audit evidence (ADR-0059 follow-up).
 *
 * "Shipped on a red build" was undetectable. The session auditor juxtaposes
 * what MARVIN CLAIMED against what actually happened — tools that ran, files
 * that changed — but CI was not in the packet, so a turn could announce a
 * release while the suite was failing and nothing contradicted it. Four
 * releases went out red before anyone noticed (fixed at the workflow level by
 * gating release.yml on test.yml; this is the detection half).
 *
 * Split the same way `computeGraphFreshness` is: a PURE interpreter over data,
 * plus a thin best-effort collector. The interpretation — including "the run we
 * found is for a different commit, so it says nothing about this one" — is
 * where the subtlety lives, so that part is unit-testable without a network,
 * a repo, or `gh` installed.
 */

import { execFileSync } from "node:child_process";

export type CiState =
  /** A run for THIS commit succeeded. */
  | "green"
  /** A run for THIS commit failed, was cancelled, or timed out. */
  | "red"
  /** A run for this commit is still going. */
  | "running"
  /** Runs exist, but none for this commit — says nothing either way. */
  | "stale"
  /** Couldn't look: no `gh`, no remote, not authenticated, no runs at all. */
  | "unknown";

export interface CiStatus {
  state: CiState;
  /** Why we couldn't look, when `state` is "unknown". User-facing. */
  reason?: string;
  /** The commit the newest run we found was for. */
  runSha?: string;
  /** The commit the working tree is actually on. */
  headSha?: string;
  workflow?: string;
  conclusion?: string;
  url?: string;
}

/** One `gh run list --json` row, narrowed to what we use. */
export interface GhRun {
  headSha?: unknown;
  conclusion?: unknown;
  status?: unknown;
  workflowName?: unknown;
  url?: unknown;
}

/**
 * Interpret `gh run list` output against the commit the tree is on.
 *
 * The load-bearing case is `stale`: a run for a DIFFERENT commit is not
 * evidence about this one. Reporting the last green run as "green" when the
 * session has committed since would let a red build hide behind an older pass —
 * exactly the failure this is meant to catch. Silence is the honest answer.
 */
export function interpretCiRuns(runs: GhRun[], headSha: string | null): CiStatus {
  if (!headSha) return { state: "unknown", reason: "could not resolve HEAD" };
  if (runs.length === 0) {
    return { state: "unknown", reason: "no workflow runs found", headSha };
  }
  const latest = runs[0];
  const runSha = typeof latest?.headSha === "string" ? latest.headSha : undefined;
  const workflow = typeof latest?.workflowName === "string" ? latest.workflowName : undefined;
  const url = typeof latest?.url === "string" ? latest.url : undefined;
  const status = typeof latest?.status === "string" ? latest.status : "";
  const conclusion = typeof latest?.conclusion === "string" ? latest.conclusion : "";

  const base = { runSha, headSha, workflow, url, ...(conclusion ? { conclusion } : {}) };

  if (!runSha || runSha !== headSha) {
    return { state: "stale", ...base };
  }
  if (status !== "completed") {
    return { state: "running", ...base };
  }
  switch (conclusion) {
    case "success":
      return { state: "green", ...base };
    case "failure":
    case "timed_out":
    case "cancelled":
    case "startup_failure":
      return { state: "red", ...base };
    default:
      // `neutral`, `skipped`, `action_required`… — real outcomes we shouldn't
      // silently call green. Surface them rather than guess.
      return { state: "stale", ...base };
  }
}

/**
 * One line for the audit packet. Phrased so the auditor can only draw a
 * conclusion when there is one: `stale` and `unknown` say plainly that CI is
 * NOT evidence for this commit.
 */
export function renderCiStatus(ci: CiStatus): string {
  const wf = ci.workflow ? ` (${ci.workflow})` : "";
  const link = ci.url ? ` — ${ci.url}` : "";
  switch (ci.state) {
    case "green":
      return `CI GREEN for HEAD ${short(ci.headSha)}${wf}${link}`;
    case "red":
      return (
        `CI RED for HEAD ${short(ci.headSha)}${wf} — conclusion: ${ci.conclusion}${link}. ` +
        `If this session claimed work was shipped, released, or verified, that claim ` +
        `contradicts the build and is a finding.`
      );
    case "running":
      return `CI still RUNNING for HEAD ${short(ci.headSha)}${wf}${link} — no verdict yet; a "verified" claim is premature.`;
    case "stale":
      return (
        `CI has no run for HEAD ${short(ci.headSha)} (newest run is for ${short(ci.runSha)})` +
        `${wf}${link}. This says NOTHING about the current commit — do not treat it as a pass.`
      );
    case "unknown":
      return `CI status unavailable (${ci.reason ?? "unknown"}) — absence of evidence, not evidence of a pass.`;
  }
}

function short(sha?: string): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

/**
 * Best-effort collector. Never throws: an unavailable `gh`, an unauthenticated
 * one, or a directory that isn't a repo all degrade to `unknown`, because the
 * auditor must run offline and in projects with no GitHub remote at all.
 */
export function collectCiStatus(cwd: string): CiStatus {
  const headSha = run(cwd, "git", ["rev-parse", "HEAD"]);
  if (!headSha) return { state: "unknown", reason: "not a git repository" };

  const raw = run(cwd, "gh", [
    "run",
    "list",
    "--limit",
    "5",
    "--json",
    "headSha,conclusion,status,workflowName,url",
  ]);
  if (raw === null) {
    return { state: "unknown", reason: "gh CLI unavailable or not authenticated", headSha };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "unknown", reason: "could not parse gh output", headSha };
  }
  if (!Array.isArray(parsed)) {
    return { state: "unknown", reason: "unexpected gh output", headSha };
  }
  return interpretCiRuns(parsed as GhRun[], headSha);
}

/** Run a command, returning trimmed stdout or null on any failure. */
function run(cwd: string, cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
