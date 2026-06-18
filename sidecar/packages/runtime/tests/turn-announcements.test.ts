import { describe, expect, it } from "vitest";

import {
  endLiveTurn,
  registerLiveTurn,
  subscribeTurnAnnouncements,
  type TurnAnnouncement,
} from "../src/turn-registry";

// ADR-0043. The server fires real turns with no user message (background-job
// completion / timed wakeups). An idle client only attaches to a turn's bus on
// session hydrate, so those turns went unseen. The announcer is the missing
// push: registerLiveTurn emits a `turn.registered`, an SSE route forwards it,
// and the idle client re-attaches via the existing resume path.

describe("turn-registry — announcements (ADR-0043)", () => {
  it("registerLiveTurn announces the new turn to subscribers", () => {
    const seen: TurnAnnouncement[] = [];
    const unsub = subscribeTurnAnnouncements((a) => seen.push(a));

    const sid = `sess-${Math.random()}`;
    const turn = registerLiveTurn({
      turnId: "t1",
      marvinSessionId: sid,
      projectId: "proj-A",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      marvinSessionId: sid,
      projectId: "proj-A",
      turnId: "t1",
    });
    expect(typeof seen[0]?.startedAt).toBe("number");

    unsub();
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("unsubscribe stops further announcements", () => {
    const seen: TurnAnnouncement[] = [];
    const unsub = subscribeTurnAnnouncements((a) => seen.push(a));
    unsub();

    const sid = `sess-${Math.random()}`;
    const turn = registerLiveTurn({
      turnId: "t1",
      marvinSessionId: sid,
      projectId: "proj-A",
    });

    expect(seen).toHaveLength(0);
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });

  it("every subscriber sees the same announcement", () => {
    const a: TurnAnnouncement[] = [];
    const b: TurnAnnouncement[] = [];
    const unsubA = subscribeTurnAnnouncements((x) => a.push(x));
    const unsubB = subscribeTurnAnnouncements((x) => b.push(x));

    const sid = `sess-${Math.random()}`;
    const turn = registerLiveTurn({
      turnId: "t9",
      marvinSessionId: sid,
      projectId: "proj-Z",
    });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.turnId).toBe("t9");
    expect(b[0]?.turnId).toBe("t9");

    unsubA();
    unsubB();
    endLiveTurn(turn, { event: "turn.completed", data: {} });
  });
});
