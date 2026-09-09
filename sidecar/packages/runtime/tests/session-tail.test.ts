// `loadSessionTail` — the tail-capped transcript read (2026-09-09).
//
// Every routine hydrate asks for a tail; the old route served it by parsing
// the whole file and slicing, which cost 528 ms on a real 122 MB transcript to
// produce a 105 ms answer. The contract this pins is that the fast path
// returns EXACTLY what the slow path would have — anything else is a silent
// history corruption, which is worse than the latency it replaces.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { marvinPaths } from "../src/paths";
import { appendSessionTurn, loadSession, loadSessionTail, type SessionTurn } from "../src/session";

let dataDir: string;
const projectId = "tail-proj";

function turn(i: number): SessionTurn {
  return { type: "turn.user", at: new Date(1_700_000_000_000 + i).toISOString(), message: `m${i}` } as SessionTurn;
}

/** Write `n` turns to a fresh session and return its id. */
function seed(sessionId: string, n: number): string {
  for (let i = 0; i < n; i += 1) appendSessionTurn(projectId, sessionId, turn(i));
  return sessionId;
}

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-session-tail-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.MARVIN_DATA_DIR;
});

describe("loadSessionTail", () => {
  it("returns exactly what loading the whole file and slicing would", () => {
    const sid = seed("s-parity", 500);
    const full = loadSession(projectId, sid);
    expect(full).not.toBeNull();
    for (const n of [1, 2, 3, 199, 200, 499]) {
      const tailed = loadSessionTail(projectId, sid, n);
      expect(tailed).not.toBeNull();
      expect(tailed?.record.turns).toEqual(full?.turns.slice(-n));
      expect(tailed?.record.turns).toHaveLength(n);
    }
  });

  it("reports the true total and whether it clipped", () => {
    const sid = seed("s-total", 40);
    expect(loadSessionTail(projectId, sid, 10)).toMatchObject({ totalTurns: 40, truncated: true });
    expect(loadSessionTail(projectId, sid, 40)).toMatchObject({ totalTurns: 40, truncated: false });
    // Asking for more than exists is not an error, and is not truncated.
    const over = loadSessionTail(projectId, sid, 5000);
    expect(over?.record.turns).toHaveLength(40);
    expect(over?.truncated).toBe(false);
  });

  it("handles a one-turn transcript", () => {
    const sid = seed("s-one", 1);
    const tailed = loadSessionTail(projectId, sid, 200);
    expect(tailed?.record.turns).toHaveLength(1);
    expect(tailed?.totalTurns).toBe(1);
    expect(tailed?.truncated).toBe(false);
  });

  it("counts a final line that has no trailing newline", () => {
    // A transcript truncated by a crash mid-append has no terminator. The
    // line is still a turn, and dropping it would lose the newest one.
    const sid = "s-noeol";
    writeFileSync(
      marvinPaths.sessionFile(projectId, sid),
      `${JSON.stringify(turn(1))}\n${JSON.stringify(turn(2))}`,
      "utf-8",
    );
    const tailed = loadSessionTail(projectId, sid, 1);
    expect(tailed?.totalTurns).toBe(2);
    expect(tailed?.record.turns).toEqual([turn(2)]);
  });

  it("skips a malformed line the same way the full loader does", () => {
    const sid = "s-malformed";
    writeFileSync(
      marvinPaths.sessionFile(projectId, sid),
      `${JSON.stringify(turn(1))}\nnot json at all\n${JSON.stringify(turn(3))}\n`,
      "utf-8",
    );
    const tailed = loadSessionTail(projectId, sid, 3);
    expect(tailed?.record.turns).toEqual(loadSession(projectId, sid)?.turns);
    // The bad line still counted as a line: the total is what is on disk.
    expect(tailed?.totalTurns).toBe(3);
  });

  it("returns null for a session that does not exist", () => {
    expect(loadSessionTail(projectId, "nope", 10)).toBeNull();
  });

  it("carries the session and project identity through", () => {
    const sid = seed("s-identity", 3);
    const tailed = loadSessionTail(projectId, sid, 2);
    expect(tailed?.record.sessionId).toBe(sid);
    expect(tailed?.record.projectId).toBe(projectId);
  });
});


// `confirm.decision` — the half of the confirm pair that was never written.
//
// The type has been declared since the confirm gate shipped, and a survey of a
// real project's transcripts found **zero** records against 14 requests in one
// evening. The cost surfaced when the user asked whether background sessions
// were really working: the transcripts could say a question had been asked and
// not whether it was ever answered. These pin the record's shape, because a
// half-written pair reads as an answer.

describe("confirm.decision records", () => {
  it("round-trips beside the request that asked", () => {
    const sid = "s-confirm";
    appendSessionTurn(projectId, sid, {
      type: "confirm.request",
      at: "2026-09-10T00:00:00.000Z",
      payload: {
        turnId: "t1",
        toolUseId: "u1",
        toolName: "AskUserQuestion",
        input: {},
        reason: "which approach?",
      },
    } as SessionTurn);
    appendSessionTurn(projectId, sid, {
      type: "confirm.decision",
      at: "2026-09-10T00:04:00.000Z",
      turnId: "t1",
      toolUseId: "u1",
      decision: "allow",
    } as SessionTurn);

    const turns = loadSession(projectId, sid)?.turns ?? [];
    expect(turns).toHaveLength(2);
    const decision = turns[1] as { type: string; turnId: string; toolUseId: string; decision: string };
    expect(decision.type).toBe("confirm.decision");
    // Pairing is by (turnId, toolUseId) — the same key the registry resolves
    // on, so a reader can compute how long a session waited on a person.
    expect(decision.turnId).toBe("t1");
    expect(decision.toolUseId).toBe("u1");
    expect(decision.decision).toBe("allow");
  });

  it("keeps a deny's message", () => {
    const sid = "s-confirm-deny";
    appendSessionTurn(projectId, sid, {
      type: "confirm.decision",
      at: "2026-09-10T00:00:00.000Z",
      turnId: "t2",
      toolUseId: "u2",
      decision: "deny",
      message: "not on the default branch",
    } as SessionTurn);
    const t = (loadSession(projectId, sid)?.turns ?? [])[0] as { message?: string; decision?: string };
    expect(t.decision).toBe("deny");
    expect(t.message).toBe("not on the default branch");
  });
});
