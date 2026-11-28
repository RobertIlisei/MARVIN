/**
 * ADR-0041 addendum (2026-11-28): one machine-wide gate for graph refreshes.
 * Nine concurrent `graphify update` runs (~4 GB each) took a 36 GB Mac down.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configureGraphRefreshGate,
  graphRefreshMax,
  graphRefreshMinFreePct,
  graphRefreshStatus,
  requestGraphRefresh,
  resetGraphRefreshGate,
  STALE_MS,
} from "../src/refresh-gate";

class FakeChild extends EventEmitter {
  finish(): void {
    this.emit("close", 0);
  }
}
const asChild = (c: FakeChild) => c as unknown as ChildProcess;
const tick = () => new Promise((r) => setTimeout(r, 0));

let clock = 1_000_000;
let env: NodeJS.ProcessEnv;
let free: number | null;
let logs: string[];

beforeEach(() => {
  clock = 1_000_000;
  env = {};
  free = 80;
  logs = [];
  configureGraphRefreshGate({ now: () => clock, env: () => env, readFreePct: async () => free, log: (l) => logs.push(l) });
});
afterEach(() => resetGraphRefreshGate());

function job(): { child: FakeChild; spawned: () => number; start: () => ChildProcess } {
  const child = new FakeChild();
  let n = 0;
  return {
    child,
    spawned: () => n,
    start: () => {
      n++;
      return asChild(child);
    },
  };
}

describe("cap", () => {
  it("runs one at a time by default; the second waits and starts when the first ends", async () => {
    const a = job();
    const b = job();
    expect(requestGraphRefresh("code:/a", a.start).outcome).toBe("started");
    expect(requestGraphRefresh("code:/b", b.start).outcome).toBe("queued");
    await tick();
    expect(a.spawned()).toBe(1);
    expect(b.spawned()).toBe(0);
    expect(graphRefreshStatus()).toEqual({ running: 1, queued: 1, max: 1 });
    a.child.finish();
    await tick();
    await tick();
    expect(b.spawned()).toBe(1);
    expect(graphRefreshStatus().running).toBe(1);
    b.child.finish();
    await tick();
    expect(graphRefreshStatus()).toEqual({ running: 0, queued: 0, max: 1 });
    expect(logs.some((l) => l.startsWith("finished key=code:/a duration="))).toBe(true);
  });

  it("honours MARVIN_GRAPH_REFRESH_MAX", async () => {
    env.MARVIN_GRAPH_REFRESH_MAX = "2";
    const [a, b, c] = [job(), job(), job()];
    requestGraphRefresh("a", a.start);
    requestGraphRefresh("b", b.start);
    expect(requestGraphRefresh("c", c.start).outcome).toBe("queued");
    await tick();
    expect([a.spawned(), b.spawned(), c.spawned()]).toEqual([1, 1, 0]);
  });

  it("starts the queue FIFO", async () => {
    const order: string[] = [];
    const first = new FakeChild();
    requestGraphRefresh("a", () => asChild(first));
    for (const k of ["b", "c"]) {
      requestGraphRefresh(k, () => {
        order.push(k);
        const ch = new FakeChild();
        queueMicrotask(() => ch.finish());
        return asChild(ch);
      });
    }
    await tick();
    first.finish();
    for (let i = 0; i < 6; i++) await tick();
    expect(order).toEqual(["b", "c"]);
  });
});

describe("coalescing", () => {
  it("does not queue a key that is running or already queued", async () => {
    const a = job();
    const b = job();
    requestGraphRefresh("k", a.start);
    requestGraphRefresh("other", b.start);
    expect(requestGraphRefresh("k", job().start).outcome).toBe("coalesced");
    expect(requestGraphRefresh("other", job().start).outcome).toBe("coalesced");
    expect(graphRefreshStatus().queued).toBe(1);
    expect(logs.filter((l) => l.startsWith("coalesced")).length).toBe(2);
  });
});

describe("stale drop", () => {
  it("drops a request that waited longer than the limit and resolves it as never run", async () => {
    const a = job();
    const b = job();
    requestGraphRefresh("a", a.start);
    const waiting = requestGraphRefresh("b", b.start);
    await tick();
    clock += STALE_MS + 1;
    a.child.finish();
    expect(await waiting.done).toBeNull();
    expect(b.spawned()).toBe(0);
    expect(logs.some((l) => l.startsWith("dropped-stale key=b"))).toBe(true);
  });
});

describe("memory guard", () => {
  it("skips below the minimum, keeps the slot free, and logs once a minute", async () => {
    free = 10;
    const a = job();
    expect(await requestGraphRefresh("a", a.start).done).toBeNull();
    expect(a.spawned()).toBe(0);
    expect(await requestGraphRefresh("b", job().start).done).toBeNull();
    expect(logs.filter((l) => l.startsWith("skipped-low-memory")).length).toBe(1);
    clock += 61_000;
    await requestGraphRefresh("c", job().start).done;
    expect(logs.filter((l) => l.startsWith("skipped-low-memory")).length).toBe(2);
    expect(graphRefreshStatus().running).toBe(0);
  });

  it("uses MARVIN_GRAPH_REFRESH_MIN_FREE_PCT and runs when memory is enough or unreadable", async () => {
    env.MARVIN_GRAPH_REFRESH_MIN_FREE_PCT = "50";
    free = 40;
    expect(await requestGraphRefresh("a", job().start).done).toBeNull();
    free = 60;
    const b = job();
    requestGraphRefresh("b", b.start);
    await tick();
    expect(b.spawned()).toBe(1);
    b.child.finish();
    await tick();
    free = null;
    const c = job();
    requestGraphRefresh("c", c.start);
    await tick();
    expect(c.spawned()).toBe(1);
  });

  it("releases the slot when the spawn fails or errors", async () => {
    expect(await requestGraphRefresh("a", () => null).done).toBeNull();
    const ch = new FakeChild();
    const r = requestGraphRefresh("b", () => asChild(ch));
    await tick();
    ch.emit("error", new Error("ENOENT"));
    expect(typeof (await r.done)).toBe("number");
    expect(graphRefreshStatus().running).toBe(0);
  });
});

describe("env validation", () => {
  it("accepts only integers in range", () => {
    expect(graphRefreshMax({})).toBe(1);
    expect(graphRefreshMax({ MARVIN_GRAPH_REFRESH_MAX: "3" })).toBe(3);
    for (const bad of ["0", "5", "-1", "2.5", "two", "", "1e1"]) expect(graphRefreshMax({ MARVIN_GRAPH_REFRESH_MAX: bad })).toBe(1);
    expect(graphRefreshMinFreePct({})).toBe(30);
    expect(graphRefreshMinFreePct({ MARVIN_GRAPH_REFRESH_MIN_FREE_PCT: "5" })).toBe(5);
    expect(graphRefreshMinFreePct({ MARVIN_GRAPH_REFRESH_MIN_FREE_PCT: "90" })).toBe(90);
    for (const bad of ["4", "91", "x", "30.5"]) expect(graphRefreshMinFreePct({ MARVIN_GRAPH_REFRESH_MIN_FREE_PCT: bad })).toBe(30);
  });
});
