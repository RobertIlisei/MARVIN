/**
 * TurnInputChannel — streaming input for one turn (ADR-0076).
 *
 * The Agent SDK has two input modes. MARVIN used single-message mode
 * (`query({ prompt: string })`), which the SDK docs say does NOT support
 * "dynamic message queueing" or "real-time interruption". Streaming input
 * mode (`prompt: AsyncIterable<SDKUserMessage>`) does: the CLI keeps the
 * session open and processes further user messages sequentially — this is
 * how Claude Code lets you keep typing while it works.
 *
 * This channel is that iterable. `stream(first)` yields the turn's first
 * message, then suspends until `push()` delivers another or `close()` ends
 * the turn. `runAgent` closes it when a `result` arrives with nothing
 * pending, so a turn still terminates exactly as before when the user sent
 * nothing extra. Anything pushed after close (or left unconsumed) is
 * returned by `drainUnconsumed()` so the orchestrator can hand it to the
 * durable queue (ADR-0069) — no message is ever dropped.
 */

export interface TurnUserMessage {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
}

export class TurnInputChannel {
  private queue: string[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  /** Messages accepted by `push` but never yielded (turn closed first). */
  private unconsumed: string[] = [];
  /**
   * The message currently handed to the consumer but not yet PROVEN taken.
   *
   * An async generator that resumes from an internal `await` runs forward to
   * its next `yield` on its own. If the consumer has stopped iterating, that
   * yielded value fulfils an abandoned request and is held nowhere this class
   * can see: it is already out of `queue`, and `drainUnconsumed` returns
   * nothing. That is how a message POSTed 12 ms before a turn ended was
   * accepted (202 `injected: true`), persisted as `turn.user`, rendered to the
   * user — and never seen by the model. No `turn.started` ever followed it.
   *
   * Holding it here until the generator resumes past the `yield` — which only
   * happens when the consumer asks for the NEXT message, i.e. proof it took
   * this one — makes it recoverable by `close()`.
   */
  private inFlight: string | null = null;
  /** Count of messages yielded to the SDK after the first one. */
  injectedCount = 0;

  /** True once the channel has been closed — `push` will refuse. */
  get isClosed(): boolean {
    return this.closed;
  }

  get pending(): number {
    return this.queue.length;
  }

  /** Deliver a user message into the running turn. False if closed. */
  push(text: string): boolean {
    if (this.closed) return false;
    this.queue.push(text);
    this.waiter?.();
    this.waiter = null;
    return true;
  }

  /** End the input stream. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // `inFlight` first — it was pushed before anything still in `queue`, and
    // the drain replays in order. Recovering it may re-deliver a message the
    // consumer took in the microtask gap between fulfilling its request and
    // issuing the next one; that window is vanishingly small, and ADR-0069 is
    // explicit that a duplicate is the acceptable failure and a loss is not.
    if (this.inFlight !== null) {
      this.unconsumed.push(this.inFlight);
      this.inFlight = null;
    }
    this.unconsumed.push(...this.queue);
    this.queue = [];
    this.waiter?.();
    this.waiter = null;
  }

  /** Messages that never reached the SDK; caller re-queues them durably. */
  drainUnconsumed(): string[] {
    const out = this.unconsumed;
    this.unconsumed = [];
    return out;
  }

  async *stream(first: string): AsyncGenerator<TurnUserMessage> {
    yield wrap(first);
    while (true) {
      if (this.queue.length > 0) {
        const next = this.queue.shift() as string;
        this.inFlight = next;
        yield wrap(next);
        // Reached only when the consumer requests ANOTHER message, which it
        // does only after taking this one. Counting the injection here rather
        // than before the `yield` keeps `injectedCount` a record of messages
        // the SDK actually received, not of messages this class handed to a
        // request that may already have been abandoned.
        this.inFlight = null;
        this.injectedCount += 1;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function wrap(text: string): TurnUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
}
