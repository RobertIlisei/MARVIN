/**
 * Check-back promise guard (ADR-0055).
 *
 * MARVIN's firm surface (personality.ts) says: if you tell the user you'll
 * check back, you MUST arm a `schedule_wakeup` or `run_background_job`. That's
 * a prose MUST — and prose MUSTs fire unreliably (the recurring lesson behind
 * every "firm surface" in this repo). Observed 2026-07-23: a turn narrated
 * "…pipeline #2701545119 is running — I'll check back in ~7 minutes", armed
 * nothing, and ended. Nothing ever re-invoked it; the user waited forever.
 *
 * This is the mechanical backstop. At turn end, if the final assistant message
 * PROMISES a check-back and NO follow-through mechanism was armed during the
 * turn, the runtime arms the wakeup itself — parsing the delay from the message
 * and synthesising a prompt that makes the fired turn actually follow through.
 *
 * Pure functions only (no I/O) — the caller (`sdk-runner`) owns the
 * `scheduleWakeup` call and the config. This keeps the detector trivially
 * testable.
 */

export interface CheckBackDetection {
  /** The promise sentence, trimmed — quoted back into the fired turn's prompt. */
  quote: string;
  /** Delay to fire after, in seconds. Parsed from the message when it names a
   *  time ("~7 minutes"); otherwise a conservative default. Clamped to the
   *  scheduler's [60, 86400] range. */
  delaySeconds: number;
}

const MIN_DELAY = 60;
const MAX_DELAY = 86_400;
/** When the promise names no time ("I'll check back once it's done"), fire
 *  after this. 5 minutes: long enough that a build/CI usually has moved, short
 *  enough that the user isn't left hanging. */
const DEFAULT_DELAY = 300;

/**
 * Promise patterns — each already embeds the first-person commitment, so a bare
 * mention ("you could check back later") doesn't trip it. Matched against the
 * final assistant text; case-insensitive.
 */
const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bi(?:'|’)?ll\s+(?:check|circle|report|come|get)\s+back\b/i,
  /\b(?:check|circle|report)\s+back\s+(?:in|once|when|after|shortly|soon)\b/i,
  /\bi(?:'|’)?ll\s+(?:let\s+you\s+know|keep\s+you\s+posted|update\s+you|ping\s+you)\b/i,
  /\bi(?:'|’)?ll\s+keep\s+an\s+eye\b/i,
  /\bi(?:'|’)?ll\s+(?:be\s+)?(?:monitor|watch)(?:ing)?\b/i,
  /\bi(?:'|’)?ll\s+(?:continue|resume|pick\s+(?:this|it)\s+up|follow\s+up)\b[^.!?\n]{0,40}\b(?:when|once|after|in)\b/i,
  /\bi(?:'|’)?ll\s+[^.!?\n]{0,40}\bin\s+~?\s*\d+\s*(?:min|minute|hour|h\b|sec|second)/i,
];

/** Duration units → seconds. */
const UNIT_SECONDS: Record<string, number> = {
  sec: 1, secs: 1, second: 1, seconds: 1,
  min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
};

/** Clamp to the scheduler's accepted window. */
function clampDelay(seconds: number): number {
  return Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(seconds)));
}

/**
 * Parse the FIRST "~N unit" duration from the text, e.g. "~7 minutes" → 420.
 * Returns null when the text names no duration. Ignores a duration that is
 * clearly not a wait (we only look for one near a future/"in" cue by scanning
 * the whole message — conservative: any explicit N-unit wins, else default).
 */
export function parseDelaySeconds(text: string): number | null {
  const m = text.match(/~?\s*(\d+(?:\.\d+)?)\s*(sec|secs|seconds?|min|mins|minutes?|hours?|hrs?|hr|h)\b/i);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const per = UNIT_SECONDS[unit] ?? UNIT_SECONDS[unit.replace(/s$/, "")] ?? null;
  if (!Number.isFinite(n) || per === null) return null;
  return clampDelay(n * per);
}

/** Isolate the sentence containing the promise, trimmed for the prompt. */
function promiseSentence(text: string, matchIndex: number): string {
  const start = Math.max(
    text.lastIndexOf(".", matchIndex),
    text.lastIndexOf("\n", matchIndex),
    text.lastIndexOf("—", matchIndex),
  );
  let end = text.length;
  for (const p of [". ", "\n", "! ", "? "]) {
    const i = text.indexOf(p, matchIndex);
    if (i >= 0 && i < end) end = i;
  }
  return text.slice(start + 1, end).trim().slice(0, 240);
}

/**
 * Detect an uncovered check-back promise in the final assistant text. Returns
 * null when there's no promise (the common case — do nothing). The caller only
 * calls this when NO `schedule_wakeup`/`run_background_job` was armed this turn,
 * so a true match here means the promise is genuinely unbacked.
 */
export function detectUncoveredCheckBack(finalText: string): CheckBackDetection | null {
  if (!finalText || finalText.length < 4) return null;
  for (const re of PROMISE_PATTERNS) {
    const m = re.exec(finalText);
    if (!m) continue;
    return {
      quote: promiseSentence(finalText, m.index) || finalText.trim().slice(0, 240),
      delaySeconds: parseDelaySeconds(finalText) ?? DEFAULT_DELAY,
    };
  }
  return null;
}

/**
 * Build the `reason` + `prompt` for the auto-armed wakeup. The prompt makes the
 * fired turn FOLLOW THROUGH (check the real status, act) rather than re-promise.
 */
export function buildCheckBackWakeup(d: CheckBackDetection): { reason: string; prompt: string } {
  return {
    reason: "auto-armed: unbacked check-back promise (ADR-0055)",
    prompt:
      `Earlier this session you told the user you would follow up — your words: ` +
      `"${d.quote}". The wait you set is over. Follow through NOW: check the ACTUAL ` +
      `status of whatever you referenced (the CI run / build / deploy / external ` +
      `task), read the real result, and act on it — fix a failure, confirm success, ` +
      `or tell the user plainly if you genuinely cannot check. Do NOT simply ` +
      `re-promise to check back.`,
  };
}
