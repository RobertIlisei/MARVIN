import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __keepAwakeStateForTests,
  __setKeepAwakeDepsForTests,
  noteTurnEnded,
  noteTurnStarted,
} from "../src/keep-awake";

// ADR-0120 — the sidecar holds one idle-sleep assertion from the first live
// turn to the last one's end. Measured: 51 of 51 stalls in a 20-hour session
// were the Mac asleep (pmset `sleep 1` on AC), ~11 hours in total.

function fakeSpawn() {
  const children: Array<EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; unref: () => void }> = [];
  const spawn = vi.fn((_cmd: string, _args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1000 + children.length,
      kill: vi.fn(),
      unref: () => {},
    });
    children.push(child);
    return child;
  });
  return { spawn: spawn as unknown as typeof import("node:child_process").spawn, calls: spawn, children };
}

afterEach(() => __setKeepAwakeDepsForTests(null));

describe("keep-awake (ADR-0120)", () => {
  it("raises caffeinate -i -w <sidecar pid> on the first live turn and releases it after the last", () => {
    const f = fakeSpawn();
    __setKeepAwakeDepsForTests({ platform: "darwin", spawn: f.spawn, ownPid: 4242, env: {} });

    noteTurnStarted();
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(f.calls.mock.calls[0]?.[0]).toBe("caffeinate");
    expect(f.calls.mock.calls[0]?.[1]).toEqual(["-i", "-w", "4242"]);
    expect(__keepAwakeStateForTests()).toEqual({ liveTurns: 1, holding: true });

    // A second concurrent tab shares the one assertion.
    noteTurnStarted();
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(__keepAwakeStateForTests().liveTurns).toBe(2);

    noteTurnEnded();
    expect(f.children[0]?.kill).not.toHaveBeenCalled();
    noteTurnEnded();
    expect(f.children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(__keepAwakeStateForTests()).toEqual({ liveTurns: 0, holding: false });

    // The next turn raises a fresh one; an extra end never goes negative.
    noteTurnEnded();
    noteTurnStarted();
    expect(f.calls).toHaveBeenCalledTimes(2);
    expect(__keepAwakeStateForTests().liveTurns).toBe(1);
  });

  it("does nothing off darwin or when MARVIN_KEEP_AWAKE=0", () => {
    const linux = fakeSpawn();
    __setKeepAwakeDepsForTests({ platform: "linux", spawn: linux.spawn, env: {} });
    noteTurnStarted();
    expect(linux.calls).not.toHaveBeenCalled();
    expect(__keepAwakeStateForTests()).toEqual({ liveTurns: 1, holding: false });
    noteTurnEnded();

    const off = fakeSpawn();
    __setKeepAwakeDepsForTests({ platform: "darwin", spawn: off.spawn, env: { MARVIN_KEEP_AWAKE: "0" } });
    noteTurnStarted();
    expect(off.calls).not.toHaveBeenCalled();
    noteTurnEnded();
  });

  it("a caffeinate that dies on its own is forgotten, and a spawn failure never throws", () => {
    const f = fakeSpawn();
    __setKeepAwakeDepsForTests({ platform: "darwin", spawn: f.spawn, env: {} });
    noteTurnStarted();
    f.children[0]?.emit("exit", 0, null);
    expect(__keepAwakeStateForTests().holding).toBe(false);
    noteTurnEnded();

    const throwing = vi.fn(() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;
    __setKeepAwakeDepsForTests({ platform: "darwin", spawn: throwing, env: {} });
    expect(() => noteTurnStarted()).not.toThrow();
    expect(__keepAwakeStateForTests()).toEqual({ liveTurns: 1, holding: false });
    noteTurnEnded();
  });
});
