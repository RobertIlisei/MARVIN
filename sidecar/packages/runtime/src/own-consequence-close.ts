/**
 * ADR-0121 addendum (2026-11-26) — settle the own-change backlog items at a
 * scope-met close.
 *
 * ADR-0121 sends a tab back when a provisional item it parked names something
 * its own changes touched. The answers it offered were fix it, `keep` it as
 * pre-existing, or leave it and do not claim scope met. A tab whose item waits
 * on someone else (the supervisor took it, a branch it may not merge) has no
 * true answer among those, and the check re-fired at every close: five times
 * on one real tab, which never closed.
 *
 * Two additions, both in ADR-0104 / ADR-0138's house style:
 *
 *  - A way out that is stated and recorded: `Handed over: <id> to <who> —
 *    <reason>` in the final message. It writes a dated note on the item and
 *    leaves it `provisional` — the keep / dismiss consent stays the user's
 *    (ADR-0047), and a hand-over is never a promotion.
 *  - A brake: one item refuses a session's close at most
 *    `OWN_CONSEQUENCE_MAX_BLOCKS` times, then the close is allowed and the
 *    bypass is logged and noted on the item. Counted on the session meta.
 *
 * Machine turns need no special case: the corrective turn is itself a wakeup,
 * and the line it writes is read the same way.
 */

import { updateBacklogItem } from "./backlog";
import { readSessionMeta, updateSessionMeta } from "./session-meta";
import { type OwnConsequence, partitionOwnConsequences } from "./workflow-guard";

/** In-process copy of the counts, for a session whose meta cannot be written. */
const memoryBlocks = new Map<string, Record<string, number>>();

/** Test hook: forget the in-process counts, as a restart would. */
export function __resetOwnConsequenceBlocksForTests(): void {
  memoryBlocks.clear();
}

const NOTE_REASON_MAX = 300;

function tel(fields: Record<string, unknown>): void {
  try {
    console.info("[marvin.telemetry] " + JSON.stringify({ ...fields, at: new Date().toISOString() }));
  } catch {
    /* never break a turn on telemetry */
  }
}

/**
 * Which of `own` the tab must still be asked about. Writes the hand-over notes
 * and the bypass notes, counts the refusals, and logs; a failure to record
 * leaves the item asked about, never silently passed.
 */
export async function settleOwnConsequences(args: {
  workDir: string;
  projectId: string;
  sessionId: string;
  finalText: string;
  own: OwnConsequence[];
  maxBlocks: number;
}): Promise<OwnConsequence[]> {
  const { workDir, projectId, sessionId, finalText, own, maxBlocks } = args;
  if (own.length === 0) return [];
  const key = `${projectId}:${sessionId}`;
  const stored = { ...(readSessionMeta(projectId, sessionId)?.ownConsequenceBlocks ?? {}) };
  const blocks: Record<string, number> = { ...stored };
  for (const [id, n] of Object.entries(memoryBlocks.get(key) ?? {})) blocks[id] = Math.max(blocks[id] ?? 0, n);

  const part = partitionOwnConsequences(own, finalText, blocks, maxBlocks);
  const ask = [...part.ask];

  for (const h of part.handedOver) {
    const note = `handed over to ${h.who}: ${h.reason.slice(0, NOTE_REASON_MAX)} (tab ${sessionId.slice(0, 8)}; still provisional, the user decides keep or dismiss)`;
    const res = await updateBacklogItem(workDir, h.id, { note }).catch((err: unknown) => ({ ok: false as const, error: String(err) }));
    if (res.ok) {
      tel({ kind: "own.consequence.handover", sessionId, item: h.id, who: h.who });
    } else {
      // The record is the point; without it the item is still asked about.
      tel({ kind: "own.consequence.handover.failed", sessionId, item: h.id, error: res.error.slice(0, 160) });
      ask.push({ id: h.id, title: h.title, because: h.because });
    }
  }

  for (const b of part.bypassed) {
    await updateBacklogItem(workDir, b.id, {
      note: `close allowed after ${maxBlocks} refusals with this item unresolved (tab ${sessionId.slice(0, 8)}); still provisional, for the user to review`,
    }).catch(() => undefined);
    tel({ kind: "own.consequence.bypass", sessionId, item: b.id, blocks: blocks[b.id] ?? maxBlocks });
  }

  // Count one refusal for every item still asked about.
  if (ask.length > 0) {
    for (const a of ask) blocks[a.id] = (blocks[a.id] ?? 0) + 1;
    memoryBlocks.set(key, blocks);
    for (const a of ask) tel({ kind: "own.consequence.block", sessionId, item: a.id, blocks: blocks[a.id] });
    try {
      updateSessionMeta(projectId, sessionId, { ownConsequenceBlocks: blocks });
    } catch {
      /* the in-process count above is the local brake */
    }
  }
  return ask;
}
