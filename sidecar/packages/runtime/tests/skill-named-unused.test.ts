import { describe, expect, it } from "vitest";

import { COST_UNITS, extractAll, FINGERPRINT_KINDS, parseSessionTranscript, POLARITY } from "../src/practice-extractors";

// ADR-0138 — `skill.named.unused`: the brief named a skill, the session closed
// scope-met, and the skill never ran and was never waived.

type Line = Record<string, unknown>;
let seq = 0;

function turn(at: string, message: string, tools: Array<{ name: string; input: Record<string, unknown> }>, text: string): Line[] {
  const out: Line[] = [
    { type: "turn.user", at, message },
    { type: "turn.started", at, turnId: `t-${at}` },
  ];
  for (const t of tools) {
    const id = `toolu_${++seq}`;
    out.push({ type: "cli.event", at, event: { type: "assistant", message: { content: [{ type: "tool_use", id, name: t.name, input: t.input }] } } });
    out.push({ type: "cli.event", at, event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: false }] } } });
  }
  out.push({ type: "cli.event", at, event: { type: "assistant", message: { content: [{ type: "text", text }] } } });
  out.push({ type: "turn.completed", at, tokenUsage: { cache_creation_input_tokens: 1 }, costUsd: 0.1 });
  return out;
}
const raw = (...turns: Line[][]): string => `${turns.flat().map((l) => JSON.stringify(l)).join("\n")}\n`;
const unused = (r: string) =>
  extractAll(parseSessionTranscript("s", r))
    .filter((o) => o.fingerprint.startsWith("skill.named.unused:"))
    .map((o) => o.fingerprint)
    .sort();

const BRIEF = "Build it.\n\nSkills: `ponytail` (full), `pr-review`, `ponytail-review`.\n\nDone when: x";
const CLOSE = "Done.\n\n**Scope met:** it ships. Anything else, or should I stop?\n<!-- marvin:scope-met -->";
const skill = (name: string) => ({ name: "Skill", input: { skill: name } });

describe("skill.named.unused", () => {
  it("is a registered failure kind counted in sessions", () => {
    expect(FINGERPRINT_KINDS).toContain("skill.named.unused");
    expect(POLARITY["skill.named.unused"]).toBe("failure");
    expect(COST_UNITS["skill.named.unused"]).toBe("sessions");
  });

  it("names each skill the brief listed that never ran, on a scope-met close; namespaced runs count", () => {
    const r = raw(turn("2026-11-01T10:00:00Z", BRIEF, [skill("pr-review"), skill("marvin-project-local:Ponytail-Review")], CLOSE));
    expect(unused(r)).toEqual(["skill.named.unused:ponytail"]);
  });

  it("a skill run in an earlier turn counts; so does one waived in the closing message", () => {
    const early = raw(
      turn("2026-11-01T10:00:00Z", BRIEF, [skill("ponytail:ponytail"), skill("pr-review")], "step one"),
      turn("2026-11-01T11:00:00Z", "go on", [skill("ponytail-review")], CLOSE),
    );
    expect(unused(early)).toEqual([]);
    const waived = raw(turn("2026-11-01T10:00:00Z", BRIEF, [skill("pr-review")], `${CLOSE}\nSkill not used: ponytail — a one-line change\nSkill not used: ponytail-review — same`));
    expect(unused(waived)).toEqual([]);
  });

  it("is silent without a scope-met close, without a Skills line, and on a later message that names skills", () => {
    expect(unused(raw(turn("2026-11-01T10:00:00Z", BRIEF, [], "Working. More to do.")))).toEqual([]);
    expect(unused(raw(turn("2026-11-01T10:00:00Z", "just do it", [], CLOSE)))).toEqual([]);
    expect(unused(raw(turn("2026-11-01T10:00:00Z", "hello", [], "hi"), turn("2026-11-01T11:00:00Z", BRIEF, [], CLOSE)))).toEqual([]);
  });

  it("a subagent's Skill call is not the session's", () => {
    const lines = turn("2026-11-01T10:00:00Z", BRIEF, [], CLOSE);
    const sub = lines.find((l) => l.type === "turn.started") as Line;
    const nested: Line = {
      type: "cli.event",
      at: "2026-11-01T10:00:00Z",
      event: { type: "assistant", parent_tool_use_id: "toolu_parent", message: { content: [{ type: "tool_use", id: "toolu_x", name: "Skill", input: { skill: "ponytail" } }] } },
    };
    lines.splice(lines.indexOf(sub) + 1, 0, nested);
    expect(unused(raw(lines))).toEqual(["skill.named.unused:ponytail", "skill.named.unused:ponytail-review", "skill.named.unused:pr-review"]);
  });
});
