import { describe, expect, it } from "vitest";

import { TurnInputChannel } from "../src/turn-input";

// ADR-0076 — streaming input for mid-turn steering. The channel is the
// AsyncIterable handed to the SDK; these pin the contract the runner and
// the orchestrator rely on: first message is immediate, pushes are
// delivered in order, close ends the stream, and nothing is ever lost —
// what the SDK didn't consume comes back out of `drainUnconsumed`.

async function collect(gen: AsyncGenerator<{ message: { content: string } }>, n: number) {
  const out: string[] = [];
  for await (const m of gen) {
    out.push(m.message.content);
    if (out.length === n) break;
  }
  return out;
}

describe("TurnInputChannel", () => {
  it("yields the first message immediately", async () => {
    const ch = new TurnInputChannel();
    const gen = ch.stream("hello");
    const first = await gen.next();
    expect(first.value?.message.content).toBe("hello");
    expect(first.value?.type).toBe("user");
    expect(first.value?.parent_tool_use_id).toBeNull();
  });

  it("delivers pushed messages in order, then ends on close", async () => {
    const ch = new TurnInputChannel();
    const gen = ch.stream("first");
    expect(ch.push("second")).toBe(true);
    expect(ch.push("third")).toBe(true);
    const got: string[] = [];
    got.push((await gen.next()).value!.message.content);
    got.push((await gen.next()).value!.message.content);
    got.push((await gen.next()).value!.message.content);
    ch.close();
    const end = await gen.next();
    expect(end.done).toBe(true);
    expect(got).toEqual(["first", "second", "third"]);
    expect(ch.injectedCount).toBe(2);
  });

  it("wakes a consumer suspended on an empty queue when a message is pushed", async () => {
    const ch = new TurnInputChannel();
    const gen = ch.stream("first");
    await gen.next();
    const pending = gen.next(); // suspends — nothing queued
    setTimeout(() => ch.push("late"), 5);
    const r = await pending;
    expect(r.value?.message.content).toBe("late");
  });

  it("refuses pushes after close and returns unconsumed messages", async () => {
    const ch = new TurnInputChannel();
    const gen = ch.stream("first");
    await gen.next();
    ch.push("never-consumed");
    ch.close();
    expect(ch.push("too-late")).toBe(false);
    expect(ch.isClosed).toBe(true);
    // The consumer sees the stream end without the unconsumed message…
    const end = await gen.next();
    expect(end.done).toBe(true);
    // …and the orchestrator gets it back to re-queue durably.
    expect(ch.drainUnconsumed()).toEqual(["never-consumed"]);
    expect(ch.drainUnconsumed()).toEqual([]);
  });

  // REGRESSION (2026-08-29). A message POSTed 12 ms before a turn ended was
  // accepted (202 `injected: true`), written to the transcript as `turn.user`,
  // rendered to the user — and never reached the model. No `turn.started`
  // followed it. The cause is below: an async generator resuming from its
  // internal `await` runs forward to the next `yield` on its own, so the item
  // left `queue` and fulfilled a request the SDK had already abandoned. It was
  // then in neither `queue` nor `unconsumed`, so `drainUnconsumed` — the whole
  // no-message-is-ever-lost mechanism — returned nothing.
  it("recovers a message stranded on a request the consumer abandoned", async () => {
    const ch = new TurnInputChannel();
    const it = ch.stream("first")[Symbol.asyncIterator]();
    expect((await it.next()).value?.message.content).toBe("first");

    // The SDK asks for another message, then its turn completes and it stops
    // caring about the answer. The request stays pending forever.
    void it.next();
    await new Promise((r) => setTimeout(r, 5));

    // The user POSTs here. The channel is open, so `push` — and therefore the
    // route's `inflight.inject?.(message)` — reports success.
    expect(ch.push("how are we looking so far ?")).toBe(true);
    await new Promise((r) => setTimeout(r, 5));

    // What `runAgent` sees at the terminal `result`: nothing pending, so it
    // treats the result as final and closes. This is why the turn ended.
    expect(ch.pending).toBe(0);
    // And the message was never proven taken, so it is not counted as injected.
    expect(ch.injectedCount).toBe(0);

    ch.close();
    expect(ch.drainUnconsumed()).toEqual(["how are we looking so far ?"]);
  });

  it("does not re-queue a message the consumer actually took", async () => {
    const ch = new TurnInputChannel();
    const it = ch.stream("first")[Symbol.asyncIterator]();
    await it.next();
    const request = it.next();
    ch.push("second");
    expect((await request).value?.message.content).toBe("second");
    // The driver immediately asks for the next message — proof it took this
    // one. Only then is the injection counted and the in-flight slot released.
    void it.next();
    await new Promise((r) => setTimeout(r, 5));
    expect(ch.injectedCount).toBe(1);

    ch.close();
    expect(ch.drainUnconsumed()).toEqual([]);
  });

  it("pending reflects what the SDK has not yet consumed", async () => {
    const ch = new TurnInputChannel();
    const gen = ch.stream("first");
    await gen.next();
    ch.push("a");
    ch.push("b");
    expect(ch.pending).toBe(2);
    await collect(gen, 1);
    expect(ch.pending).toBe(1);
  });
});
