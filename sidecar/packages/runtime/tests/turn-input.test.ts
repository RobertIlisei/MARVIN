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
