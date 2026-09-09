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
