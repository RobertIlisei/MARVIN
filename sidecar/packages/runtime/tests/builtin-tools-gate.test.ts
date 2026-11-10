/**
 * Agent SDK 0.3.301 upgrade (docs/reviews/2026-10-16-agent-sdk-0.3.301-upgrade-plan.md §2).
 *
 * Built-in tools outside the gated set used to be auto-allowed by name. Two
 * kinds cannot be: a tool that runs a shell command (Monitor, PowerShell) must
 * meet the Bash classifier, and a tool that reaches beyond the turn (fan-out,
 * durable or cloud schedules, publishing) must never run from a sub-agent or a
 * read-only turn. And every built-in a new SDK ships must be classified on
 * purpose, so the next one cannot arrive auto-allowed.
 */
import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk";
import { KNOWN_TOOL_NAMES } from "@marvin/tools/policy";
import { describe, expect, it } from "vitest";

import {
  HARMLESS_BUILTIN_TOOLS,
  MAIN_DISALLOWED_TOOLS,
  OUTWARD_BUILTIN_TOOLS,
  SHELL_BUILTIN_TOOLS,
  classifyToolCall,
} from "../src/sdk-runner";

describe("shell-running built-ins meet the Bash classifier", () => {
  it("denies a destructive Monitor command exactly like Bash", () => {
    const viaBash = classifyToolCall("Bash", { command: "rm -rf /" });
    const viaMonitor = classifyToolCall("Monitor", { command: "rm -rf /", description: "x" });
    expect(viaBash.decision).toBe("deny");
    expect(viaMonitor.decision).toBe("deny");
  });

  it("refuses a mutating Monitor command from a sub-agent", () => {
    const r = classifyToolCall("Monitor", { command: "touch /tmp/x && git commit -am x" }, { agentID: "scout-1" });
    expect(r.decision).toBe("deny");
  });

  it("never hands Monitor a Bash-shaped rewritten input", () => {
    const r = classifyToolCall("Monitor", { command: "ls", description: "x", timeout_ms: 1000 });
    expect(r.updatedInput).toBeUndefined();
  });
});

describe("outward built-ins", () => {
  for (const tool of ["Workflow", "RemoteTrigger", "CronCreate", "PushNotification", "Artifact"]) {
    it(`${tool}: denied to a sub-agent, denied in a read-only turn, confirmed in the main loop`, () => {
      expect(classifyToolCall(tool, {}, { agentID: "scout-1" }).decision).toBe("deny");
      expect(classifyToolCall(tool, {}, { readOnly: true }).decision).toBe("deny");
      expect(classifyToolCall(tool, {}).decision).toBe("confirm");
    });
  }
});

describe("every built-in the SDK ships is classified on purpose", () => {
  it("BUILTIN_TOOL_NAMES has no tool MARVIN has not classified", () => {
    const classified = new Set<string>([
      ...KNOWN_TOOL_NAMES,
      ...SHELL_BUILTIN_TOOLS,
      ...OUTWARD_BUILTIN_TOOLS,
      ...HARMLESS_BUILTIN_TOOLS,
      ...MAIN_DISALLOWED_TOOLS,
    ]);
    const unclassified = BUILTIN_TOOL_NAMES.filter((t) => !classified.has(t));
    expect(unclassified).toEqual([]);
  });

  it("no legacy alias maps onto a tool the gate does not know", () => {
    const classified = new Set<string>([
      ...KNOWN_TOOL_NAMES,
      ...SHELL_BUILTIN_TOOLS,
      ...OUTWARD_BUILTIN_TOOLS,
      ...HARMLESS_BUILTIN_TOOLS,
      ...MAIN_DISALLOWED_TOOLS,
    ]);
    for (const target of Object.values(LEGACY_TOOL_NAME_ALIASES)) expect(classified.has(target)).toBe(true);
  });
});
