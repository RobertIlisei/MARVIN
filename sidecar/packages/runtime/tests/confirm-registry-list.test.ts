// ADR-0107 — the confirm registry can now say WHAT is waiting on a turn, so
// a project-wide watcher can show "needs you: Bash" without attaching to the
// turn's own bus. Pins the listing, its ordering, and that it empties on
// resolve and on clear.

import { describe, expect, it } from "vitest";

import {
  clearTurnConfirms,
  listPendingConfirms,
  registerPendingConfirm,
  resolvePendingConfirm,
} from "../src/confirm-registry";

describe("listPendingConfirms", () => {
  it("lists tool names oldest first and empties as confirms resolve", () => {
    const turn = "cr-list-1";
    registerPendingConfirm(turn, "u1", () => {}, {}, 0, { toolName: "Bash" });
    registerPendingConfirm(turn, "u2", () => {}, {}, 0, { toolName: "AskUserQuestion" });
    const list = listPendingConfirms(turn);
    expect(list.map((p) => [p.toolUseId, p.toolName])).toEqual([["u1", "Bash"], ["u2", "AskUserQuestion"]]);
    expect(list.every((p) => typeof p.since === "string" && !Number.isNaN(Date.parse(p.since)))).toBe(true);

    expect(resolvePendingConfirm(turn, "u1", { behavior: "deny", message: "no", interrupt: false })).toBe(true);
    expect(listPendingConfirms(turn).map((p) => p.toolUseId)).toEqual(["u2"]);
    clearTurnConfirms(turn);
    expect(listPendingConfirms(turn)).toEqual([]);
  });

  it("an unnamed confirm still lists, as a generic tool", () => {
    const turn = "cr-list-2";
    registerPendingConfirm(turn, "u1", () => {}, {}, 0);
    expect(listPendingConfirms(turn)[0]?.toolName).toBe("tool");
    clearTurnConfirms(turn);
  });

  it("an unknown turn lists nothing", () => {
    expect(listPendingConfirms("never-registered")).toEqual([]);
  });
});
