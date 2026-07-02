/**
 * Durable per-session plan state (ADR-0052).
 *
 * ADR-0046 made the plan the session's durable spine — but "durable" was
 * client-memory + transcript-scraping on rehydrate, and ADR-0048's
 * tail-first hydration (last 200 events) broke that quietly: a plan whose
 * `# Plan` presentation had scrolled past the tail could not be
 * reconstructed after a chat switch or app relaunch. The client then
 * silently degraded to a tier-1 task list, the saved plan file froze, and
 * the ADR-0051 plan-context injection stopped — observed in production on
 * 2026-07-02 (a 13-step plan untracked for a full working day).
 *
 * This module is the fix's server half: the client PUTs its plan spine
 * (plans + activePlanId + per-step/sub-task statuses) whenever it changes,
 * and GETs it back on hydrate — no transcript scraping, no tail limit.
 * State lives NEXT TO the transcript it belongs to:
 *
 *   <dataDir>/sessions/<projectId>/<sessionId>.plans.json
 *
 * The shape is deliberately opaque to the server (the client owns the plan
 * model); the server enforces only identity hygiene and a size cap.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { marvinPaths } from "./paths";

/** Plan-state payloads are small (a few KB); 256 KB is a generous ceiling
 *  that still stops a runaway client from growing an unbounded file. */
export const PLAN_STATE_MAX_BYTES = 256 * 1024;

/** Same identity alphabet the session store relies on — rejects path
 *  traversal (`..`), separators, and anything else that could escape the
 *  sessions directory. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

function isSafeId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes("..");
}

export function planStatePath(projectId: string, sessionId: string): string {
  return join(marvinPaths.sessionsDir(projectId), `${sessionId}.plans.json`);
}

export type PlanStateResult =
  | { ok: true; state: unknown | null }
  | { ok: false; error: string };

/** Read the stored plan state. `state: null` when none has been saved —
 *  callers fall back to transcript scraping (the pre-ADR-0052 path). */
export function readPlanState(projectId: string, sessionId: string): PlanStateResult {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) {
    return { ok: false, error: "invalid projectId or sessionId" };
  }
  const p = planStatePath(projectId, sessionId);
  if (!existsSync(p)) return { ok: true, state: null };
  try {
    const raw = readFileSync(p, "utf8");
    return { ok: true, state: JSON.parse(raw) as unknown };
  } catch (err) {
    // A corrupt file must not brick hydration — report "nothing stored"
    // and let the client fall back to scraping.
    return { ok: true, state: null };
  }
}

export type WritePlanStateResult = { ok: true } | { ok: false; error: string };

/** Persist the client's plan spine. Atomic (tmp + rename) so a crash
 *  mid-write can't leave a torn file for the next hydrate. */
export function writePlanState(
  projectId: string,
  sessionId: string,
  state: unknown,
): WritePlanStateResult {
  if (!isSafeId(projectId) || !isSafeId(sessionId)) {
    return { ok: false, error: "invalid projectId or sessionId" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    return { ok: false, error: "state is not serializable" };
  }
  if (serialized === undefined || serialized === "null") {
    return { ok: false, error: "state must be a JSON object" };
  }
  if (Buffer.byteLength(serialized, "utf8") > PLAN_STATE_MAX_BYTES) {
    return { ok: false, error: `state exceeds ${PLAN_STATE_MAX_BYTES} bytes` };
  }
  const p = planStatePath(projectId, sessionId);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}
