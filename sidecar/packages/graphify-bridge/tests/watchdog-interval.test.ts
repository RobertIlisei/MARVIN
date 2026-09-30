import { describe, expect, it } from "vitest";

import { refreshIntervalMs } from "../src/watchdog";

/**
 * 2026-09-30: a 65K-node code graph took minutes per `graphify update` at
 * 100% of a core, and with several tabs committing the flat 10-minute floor
 * kept one running most of the time. The wait scales with the last run.
 */
describe("refreshIntervalMs", () => {
  const MIN = 60_000;
  it("keeps the floor for a quick run and before any run", () => {
    expect(refreshIntervalMs(0, 10 * MIN)).toBe(10 * MIN);
    expect(refreshIntervalMs(20_000, 10 * MIN)).toBe(10 * MIN);
  });
  it("waits ten times a slow run", () => {
    expect(refreshIntervalMs(3 * MIN, 10 * MIN)).toBe(30 * MIN);
  });
});
