// ADR-0107 — the project event bus. A watcher of a project must learn that
// ANY session started or ended a turn without attaching to each turn's own
// bus; the original `turn.registered` announcement keeps working unchanged.

import { afterEach, describe, expect, it } from "vitest";

import {
  announceProjectEvent,
  cancelLiveTurn,
  endLiveTurn,
  type ProjectEvent,
  registerLiveTurn,
  subscribeProjectEvents,
  subscribeTurnAnnouncements,
} from "../src/turn-registry";

let n = 0;
const session = () => `pe-sess-${(n += 1)}`;
const unsubs: Array<() => void> = [];

afterEach(() => {
  for (const u of unsubs.splice(0)) u();
});

function collect(): ProjectEvent[] {
  const out: ProjectEvent[] = [];
  unsubs.push(subscribeProjectEvents((e) => out.push(e)));
  return out;
}

describe("project events", () => {
  it("registering a turn announces turn.registered with its kind, on both channels", () => {
    const events = collect();
    const legacy: unknown[] = [];
    unsubs.push(subscribeTurnAnnouncements((a) => legacy.push(a)));
    const s = session();
    const t = registerLiveTurn({ turnId: "t1", marvinSessionId: s, projectId: "p", kind: "machine" });
    expect(events.at(-1)).toMatchObject({ event: "turn.registered", data: { marvinSessionId: s, turnId: "t1", kind: "machine" } });
    expect(legacy.at(-1)).toMatchObject({ marvinSessionId: s, turnId: "t1" });
    endLiveTurn(t, { event: "turn.completed", data: {} });
  });

  it("ending a turn announces turn.ended with the outcome and cost", () => {
    const events = collect();
    const s = session();
    const t = registerLiveTurn({ turnId: "t2", marvinSessionId: s, projectId: "p" });
    endLiveTurn(t, { event: "turn.completed", data: { costUsd: 0.42, durationMs: 10 } });
    expect(events.at(-1)).toEqual({
      event: "turn.ended",
      data: { marvinSessionId: s, projectId: "p", turnId: "t2", outcome: "completed", costUsd: 0.42 },
    });
  });

  it("an error terminal carries the error, a cancel carries the flag", () => {
    const events = collect();
    const s1 = session();
    const t1 = registerLiveTurn({ turnId: "t3", marvinSessionId: s1, projectId: "p" });
    endLiveTurn(t1, { event: "turn.error", data: { error: "boom" } });
    expect(events.at(-1)).toMatchObject({ event: "turn.ended", data: { outcome: "error", error: "boom" } });

    const s2 = session();
    registerLiveTurn({ turnId: "t4", marvinSessionId: s2, projectId: "p" });
    cancelLiveTurn(s2, "test");
    expect(events.at(-1)).toMatchObject({ event: "turn.ended", data: { turnId: "t4", outcome: "error", cancelled: true } });
  });

  it("ending twice announces once", () => {
    const events = collect();
    const s = session();
    const t = registerLiveTurn({ turnId: "t5", marvinSessionId: s, projectId: "p" });
    endLiveTurn(t, { event: "turn.completed", data: {} });
    endLiveTurn(t, { event: "turn.completed", data: {} });
    expect(events.filter((e) => e.event === "turn.ended" && e.data.turnId === "t5")).toHaveLength(1);
  });

  it("arbitrary project events pass through untouched and unsubscribe stops delivery", () => {
    const events = collect();
    announceProjectEvent({ event: "session.tree", data: { marvinSessionId: "x", projectId: "p", tree: { mode: "shared" } } });
    expect(events.at(-1)?.event).toBe("session.tree");
    for (const u of unsubs.splice(0)) u();
    announceProjectEvent({ event: "session.tree", data: { marvinSessionId: "y", projectId: "p", tree: { mode: "shared" } } });
    expect(events.filter((e) => e.event === "session.tree")).toHaveLength(1);
  });
});
