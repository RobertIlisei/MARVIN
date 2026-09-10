// ADR-0107 — the confirm registry can now say WHAT is waiting on a turn, so
// a project-wide watcher can show "needs you: Bash" without attaching to the
// turn's own bus. Pins the listing, its ordering, and that it empties on
// resolve and on clear.

import { describe, expect, it } from "vitest";

import {
  attachPendingPayload,
  clearTurnConfirms,
  confirmExcerpt,
  listPendingConfirmPayloads,
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

  // ADR-0107 addendum 2 — a late attacher gets the sheet it missed.
  it("keeps the confirm.request payload for replay, oldest first, gone once resolved", () => {
    const turn = "cr-replay-1";
    registerPendingConfirm(turn, "u1", () => {}, { command: "ls" }, 0, { toolName: "Bash" });
    registerPendingConfirm(turn, "u2", () => {}, {}, 0, { toolName: "AskUserQuestion" });
    registerPendingConfirm(turn, "u3", () => {}, {}, 0, { toolName: "Edit" });
    expect(listPendingConfirmPayloads(turn)).toEqual([]);
    expect(attachPendingPayload(turn, "u2", { turnId: turn, toolUseId: "u2", toolName: "AskUserQuestion", input: {}, reason: "choose" })).toBe(true);
    expect(attachPendingPayload(turn, "u1", { turnId: turn, toolUseId: "u1", toolName: "Bash", input: { command: "ls" }, reason: "r" })).toBe(true);
    expect(attachPendingPayload(turn, "nope", {})).toBe(false);
    // u3 never announced → not replayed; order is registration order, not attach order.
    expect(listPendingConfirmPayloads(turn).map((p) => (p as { toolUseId: string }).toolUseId)).toEqual(["u1", "u2"]);
    resolvePendingConfirm(turn, "u1", { behavior: "allow", updatedInput: {} });
    expect(listPendingConfirmPayloads(turn).map((p) => (p as { toolUseId: string }).toolUseId)).toEqual(["u2"]);
    clearTurnConfirms(turn);
    expect(listPendingConfirmPayloads(turn)).toEqual([]);
  });

  // ADR-0112 — a Needs-you row answers inline, so the list carries an excerpt.
  it("carries a one-line excerpt and the reason once the payload is attached", () => {
    const turn = "cr-excerpt-1";
    registerPendingConfirm(turn, "u1", () => {}, { command: "rm -rf build" }, 0, { toolName: "Bash" });
    expect(listPendingConfirms(turn)[0]?.excerpt).toBeUndefined();
    attachPendingPayload(turn, "u1", { turnId: turn, toolUseId: "u1", toolName: "Bash", input: { command: "rm   -rf\n build" }, reason: "destructive" });
    expect(listPendingConfirms(turn)[0]).toMatchObject({ excerpt: "rm -rf build", reason: "destructive" });
    registerPendingConfirm(turn, "u2", () => {}, {}, 0, { toolName: "AskUserQuestion" });
    attachPendingPayload(turn, "u2", { turnId: turn, toolUseId: "u2", toolName: "AskUserQuestion", input: { questions: [{ question: "Ship it?" }] }, reason: "" });
    expect(listPendingConfirms(turn).find((p) => p.toolUseId === "u2")).toMatchObject({ excerpt: "Ship it?" });
    expect(confirmExcerpt({ input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
    expect(confirmExcerpt(null)).toBeUndefined();
    clearTurnConfirms(turn);
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
