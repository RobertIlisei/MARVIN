// ADR-0107 addendum — per-session activity. The brain used to be one slot
// fed by the selected tab's own stream; a hidden tab's turn had no activity
// anywhere. Pins: the derivation from stream events, announce-on-change only,
// independence between sessions, and clearing on turn end.

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetActivityForTests,
  clearActivity,
  deriveActivity,
  getActivity,
  noteActivityEvent,
  setActivity,
} from "../src/session-activity";
import { type ProjectEvent, subscribeProjectEvents } from "../src/turn-registry";

const unsubs: Array<() => void> = [];
afterEach(() => {
  for (const u of unsubs.splice(0)) u();
  __resetActivityForTests();
});

function collect(): ProjectEvent[] {
  const out: ProjectEvent[] = [];
  unsubs.push(subscribeProjectEvents((e) => out.push(e)));
  return out;
}

const ids = (marvinSessionId: string, turnId = "t1") => ({ projectId: "p", marvinSessionId, turnId });

describe("deriveActivity", () => {
  it("assistant tool_use → tool with its name; assistant text → writing; user → thinking; else null", () => {
    expect(deriveActivity({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: {} }] } })).toEqual({ state: "tool", tool: "Bash" });
    expect(deriveActivity({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })).toEqual({ state: "writing" });
    expect(deriveActivity({ type: "assistant", message: { content: [{ type: "text", text: "…" }, { type: "tool_use", name: "Read" }] } })).toEqual({ state: "tool", tool: "Read" });
    expect(deriveActivity({ type: "user", message: { content: [{ type: "tool_result" }] } })).toEqual({ state: "thinking" });
    expect(deriveActivity({ type: "system", subtype: "init" })).toBeNull();
    expect(deriveActivity({ type: "result" })).toBeNull();
    expect(deriveActivity(null)).toBeNull();
    expect(deriveActivity({ type: "assistant", message: { content: [{ type: "thinking" }] } })).toBeNull();
  });
});

describe("activity per session", () => {
  it("announces on change only, keeps sessions independent, clears on end", () => {
    const events = collect();
    setActivity(ids("a"), "thinking");
    noteActivityEvent(ids("a"), { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    noteActivityEvent(ids("a"), { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
    noteActivityEvent(ids("b", "t9"), { type: "assistant", message: { content: [{ type: "text", text: "x" }] } });
    noteActivityEvent(ids("a"), { type: "system" });

    expect(getActivity("a")).toMatchObject({ state: "tool", tool: "Bash", turnId: "t1" });
    expect(getActivity("b")).toMatchObject({ state: "writing", turnId: "t9" });
    const activity = events.filter((e) => e.event === "session.activity").map((e) => e.data);
    expect(activity).toEqual([
      { marvinSessionId: "a", projectId: "p", turnId: "t1", state: "thinking" },
      { marvinSessionId: "a", projectId: "p", turnId: "t1", state: "tool", tool: "Bash" },
      { marvinSessionId: "b", projectId: "p", turnId: "t9", state: "writing" },
    ]);

    clearActivity("a");
    expect(getActivity("a")).toBeNull();
    expect(getActivity("b")).not.toBeNull();
  });

  it("a new turn in the same session re-announces even the same state", () => {
    const events = collect();
    setActivity(ids("a", "t1"), "thinking");
    setActivity(ids("a", "t2"), "thinking");
    expect(events.filter((e) => e.event === "session.activity")).toHaveLength(2);
    expect(getActivity("a")?.turnId).toBe("t2");
  });
});
