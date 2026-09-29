/**
 * A `result` the SDK emits before the model has seen this turn's prompt.
 *
 * When a background task from an earlier turn settles while the session is
 * idle, the next query opens with its `system/task_notification`, which the
 * SDK answers with an empty `result` (`num_turns: 0`) — and only then starts
 * the real prompt (a second `system/init` follows). The runner used to take
 * that first `result` as the end of the turn: it closed the input channel and
 * armed the kill-watchdog, the SDK stopped servicing permission requests, and
 * the model's first tool call was denied with the SDK's generic "the user
 * doesn't want to take this action". Measured 2026-09-29: 8 of 625 turns over
 * four days opened this way; 2 lost a tool call (one a `git commit`) and the
 * tab sat idle until a human noticed.
 *
 * Such a result is a preamble: keep iterating. A grace bound closes the turn
 * normally if nothing follows, so an honest empty turn can't hang.
 */

export const PREAMBLE_RESULT_GRACE_MS = 60_000;

export function isPreambleResult(facts: {
  numTurns: number | undefined;
  sawAssistant: boolean;
  sawTaskNotification: boolean;
}): boolean {
  return facts.numTurns === 0 && !facts.sawAssistant && facts.sawTaskNotification;
}
