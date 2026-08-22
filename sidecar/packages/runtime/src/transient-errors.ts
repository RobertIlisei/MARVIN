/**
 * Classifying a failed turn: transient transport blip vs a real failure
 * (ADR-0067).
 *
 * ## Why this exists
 *
 * Measured on a real 2-day session: **5.1 hours across 4 incidents** were spent
 * with the session simply dead. A turn ended with
 *
 *     API Error: Stream idle timeout - partial response received
 *
 * and nothing retried it. The session then sat there until a human noticed —
 * one of those gaps was 4.5 hours, starting at 01:47 while the user was asleep.
 * The work was not blocked on a decision, a question, or a failing test. It was
 * blocked on somebody walking back to the computer.
 *
 * A dropped socket is not a verdict about the work. It should cost seconds.
 *
 * ## The bright line
 *
 * Auto-continuing after a REAL failure would be far worse than the stall it
 * replaces: it would retry a permission denial forever, re-run a turn whose
 * context is already too long, or paper over a genuine tool error. So this
 * module is deliberately a NARROW allowlist of transport-shaped failures, and
 * everything it does not recognise is treated as terminal.
 *
 * Two categories are called out explicitly because they LOOK transient and are
 * not:
 *
 *   - **Context overflow** ("prompt is too long"). Retrying sends the same
 *     oversized prompt again. It cannot succeed, and it bills for the attempt.
 *   - **Aborts.** The user cancelled, or the watchdog fired. Restarting work
 *     somebody just stopped is the opposite of what they asked for.
 */

/**
 * Transport-shaped failures. Matched case-insensitively against the error text
 * the SDK surfaced.
 *
 * Every entry here is a failure of the PIPE, not of the work: the request never
 * landed, or the response never finished arriving. Re-entering the session is
 * safe because the model re-reads the conversation state either way.
 */
const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /stream idle timeout/i,
  /partial response received/i,
  /socket hang ?up/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /\bEPIPE\b/i,
  /\bENETDOWN\b/i,
  /\bENOTFOUND\b/i,
  /fetch failed/i,
  /network (?:error|timeout)/i,
  /request timed? ?out/i,
  /\b(?:429|5\d{2})\b.*\b(?:error|status)\b|\b(?:error|status)\b.*\b(?:429|5\d{2})\b/i,
  /\boverloaded\b/i,
  /rate.?limit/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /connection (?:closed|reset|error)/i,
];

/**
 * Failures that must NEVER auto-continue, even when their text happens to brush
 * a transient pattern. Checked FIRST — this list wins.
 */
const TERMINAL_PATTERNS: readonly RegExp[] = [
  // Retrying sends the same oversized prompt. Guaranteed to fail again.
  /prompt is too long/i,
  /context (?:length|window) exceeded/i,
  /too many tokens/i,
  // The user (or the watchdog) stopped this on purpose.
  /\babort(?:ed|error)?\b/i,
  /cancell?ed by user/i,
  /user (?:cancelled|canceled|stopped)/i,
  // Credentials and permission are not going to fix themselves in 60 seconds.
  /\b401\b|\b403\b/,
  /unauthori[sz]ed/i,
  /authentication (?:failed|error)/i,
  /invalid api key/i,
  /permission denied/i,
  /credit balance is too low/i,
  /quota exceeded/i,
];

export interface TransientVerdict {
  transient: boolean;
  /** Which rule decided it — for the telemetry line and for tests. */
  reason: string;
}

export function classifyTurnError(message: string | undefined | null): TransientVerdict {
  const text = (message ?? "").trim();
  if (!text) {
    // A turn that failed with no message at all tells us nothing. Treat as
    // terminal: silence is not evidence that retrying is safe.
    return { transient: false, reason: "empty error message" };
  }
  for (const p of TERMINAL_PATTERNS) {
    if (p.test(text)) return { transient: false, reason: `terminal:${p.source}` };
  }
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(text)) return { transient: true, reason: `transient:${p.source}` };
  }
  return { transient: false, reason: "unrecognised — treated as terminal" };
}

/**
 * How many times one causal chain may auto-continue before we stop and report
 * honestly.
 *
 * Three is enough to ride out a flaky network without turning a persistent
 * outage into an unattended retry loop that bills all night. Past this the
 * failure is not transient however it is spelled.
 */
export const MAX_AUTO_CONTINUES = 3;

/** Seconds to wait before resuming. Short enough to be unattended-useful,
 *  long enough to let a rate limit or a blip clear. Grows per attempt. */
export function autoContinueDelaySeconds(attempt: number): number {
  const backoff = [60, 180, 420];
  return backoff[Math.min(Math.max(attempt, 0), backoff.length - 1)] ?? 60;
}

/**
 * The prompt a resumed turn receives.
 *
 * Deliberately does NOT restate the task: the SDK session is resumed, so the
 * conversation is already there. Restating it invites the model to start over
 * rather than continue, which is how a retry duplicates work.
 */
export function autoContinuePrompt(errorText: string, attempt: number): string {
  return (
    `[auto-continue ${attempt}/${MAX_AUTO_CONTINUES}] The previous turn ended on a ` +
    `transport error, not on a decision: ${errorText.slice(0, 200)}\n\n` +
    "Pick up exactly where you left off. Check what actually landed before " +
    "redoing anything — the interrupted turn may have completed some of its " +
    "work. Do not restart the task from the beginning, and do not treat this " +
    "as a new instruction."
  );
}
