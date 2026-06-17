import { describe, expect, it, vi } from "vitest";

import {
  endLiveTurn,
  getLiveTurn,
  registerLiveTurn,
} from "../src/turn-registry";

// These pin the concurrency contract behind the "replaced by a newer
// turn on the same session" stream error. The bug: a second `/api/chat`
// POST on a live session evicted the running turn and only DISCONNECTED
// it — the orphaned SDK agent kept mutating the workspace while the UI
// believed it had stopped. The fix is two-fold: the route refuses a
// second turn (409, exercised via the `ended` predicate it reads), and
// eviction now ABORTS the displaced turn rather than merely silencing
// its bus.

describe("turn-registry — concurrency contract", () => {
  it("a single live turn is the one getLiveTurn returns", () => {
    const sid = `sess-${Math.random()}`;
    const turn = registerLiveTurn({
      turnId: "t1",
      marvinSessionId: sid,
      projectId: "p",
    });
    expect(getLiveTurn(sid)).toBe(turn);
    expect(turn.ended).toBe(false);
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("the route's 409 predicate (getLiveTurn && !ended) is true while a turn runs and false once it ends", () => {
    const sid = `sess-${Math.random()}`;
    const turn = registerLiveTurn({
      turnId: "t1",
      marvinSessionId: sid,
      projectId: "p",
    });
    // While running, the route would reject a second POST.
    const inflight = getLiveTurn(sid);
    expect(inflight && !inflight.ended).toBe(true);

    // After it ends, the record lingers for a grace window but is
    // marked ended, so the predicate is false and a new POST proceeds.
    endLiveTurn(turn, { event: "turn.completed", data: {} });
    const after = getLiveTurn(sid);
    expect(Boolean(after && !after.ended)).toBe(false);
  });

  it("evicting a live turn ABORTS it, marks it ended, and emits the replace error", () => {
    const sid = `sess-${Math.random()}`;
    const first = registerLiveTurn({
      turnId: "t1",
      marvinSessionId: sid,
      projectId: "p",
    });

    const errs: unknown[] = [];
    first.bus.on("event", (e: { event: string; data: unknown }) => {
      if (e.event === "turn.error") errs.push(e.data);
    });
    expect(first.abortController.signal.aborted).toBe(false);

    // Second registration on the SAME session evicts the first.
    const second = registerLiveTurn({
      turnId: "t2",
      marvinSessionId: sid,
      projectId: "p",
    });

    // The displaced turn's agent is actually aborted — not just muted.
    expect(first.abortController.signal.aborted).toBe(true);
    expect(first.ended).toBe(true);
    expect(errs).toEqual([
      { error: "replaced by a newer turn on the same session" },
    ]);

    // The new turn wins the session slot and is healthy.
    expect(getLiveTurn(sid)).toBe(second);
    expect(second.abortController.signal.aborted).toBe(false);
    endLiveTurn(second, { event: "turn.completed", data: {} });
  });

  it("does not re-abort or re-emit when the prior turn already ended", () => {
    const sid = `sess-${Math.random()}`;
    const first = registerLiveTurn({
      turnId: "t1",
      marvinSessionId: sid,
      projectId: "p",
    });
    endLiveTurn(first, { event: "turn.completed", data: {} });

    const abortSpy = vi.spyOn(first.abortController, "abort");
    const second = registerLiveTurn({
      turnId: "t2",
      marvinSessionId: sid,
      projectId: "p",
    });
    // The already-ended turn is not aborted again.
    expect(abortSpy).not.toHaveBeenCalled();
    expect(getLiveTurn(sid)).toBe(second);
    endLiveTurn(second, { event: "turn.completed", data: {} });
  });
});
