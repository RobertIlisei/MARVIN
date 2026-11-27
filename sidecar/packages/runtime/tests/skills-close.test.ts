import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before any import that reads the data dir: the practice rows live there.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skills-close-data-"));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBuiltinCacheForTests, BUILTIN_RULE_IDS, ensureBuiltinRules, readRules, updateRule } from "../src/practice";
import type { SkillCloseFacts } from "../src/skill-brief";
import { decideSkillClose, makeTurnCloseStopHook, type TurnCloseFacts } from "../src/turn-close-hook";

// ADR-0138 — a scope-met close while a skill the brief named never ran.
const SCOPE_MET = "All done.\n\n**Scope met:** the migration ships. Anything else, or should I stop?\n<!-- marvin:scope-met -->";
const facts = (over: Partial<SkillCloseFacts> = {}): SkillCloseFacts => ({
  required: ["ponytail", "pr-review", "ponytail-review"],
  used: ["pr-review"],
  unavailable: [],
  blocks: 0,
  ...over,
});

describe("decideSkillClose", () => {
  it("blocks a scope-met close and names every skill that never ran, with both ways out", () => {
    const r = decideSkillClose(SCOPE_MET, facts());
    expect(r.block?.kind).toBe("skills-unused");
    expect(r.block?.reason).toContain("`ponytail`");
    expect(r.block?.reason).toContain("`ponytail-review`");
    expect(r.block?.reason).not.toContain("`pr-review`");
    expect(r.block?.reason).toContain('Skill { skill: "ponytail" }');
    expect(r.block?.reason).toContain("Skill not used: <name>");
  });

  it("lets a close through when every named skill ran, and ignores a turn that does not claim scope met", () => {
    expect(decideSkillClose(SCOPE_MET, facts({ used: ["ponytail", "pr-review", "ponytail-review"] })).block).toBeNull();
    expect(decideSkillClose("Still working on it.", facts()).block).toBeNull();
  });

  it("accepts the waiver line for each missing skill, and reports which were waived", () => {
    const text = `${SCOPE_MET}\n\nSkill not used: ponytail — a one-line config change, nothing to simplify\nSkill not used: ponytail-review - same reason`;
    const r = decideSkillClose(text, facts());
    expect(r.block).toBeNull();
    expect(r.waived.sort()).toEqual(["ponytail", "ponytail-review"]);
  });

  it("a waiver for one skill does not excuse another", () => {
    const r = decideSkillClose(`${SCOPE_MET}\nSkill not used: ponytail — trivial`, facts());
    expect(r.block?.reason).toContain("`ponytail-review`");
    expect(r.block?.reason).not.toContain("`ponytail` ");
    expect(r.waived).toEqual(["ponytail"]);
  });

  it("a skill the session cannot invoke is reported, not blocked on", () => {
    const r = decideSkillClose(SCOPE_MET, facts({ unavailable: ["ponytail", "ponytail-review"] }));
    expect(r.block).toBeNull();
    expect(r.unavailable.sort()).toEqual(["ponytail", "ponytail-review"]);
    const partly = decideSkillClose(SCOPE_MET, facts({ unavailable: ["ponytail"] }));
    expect(partly.block?.reason).toContain("`ponytail-review`");
    expect(partly.unavailable).toEqual(["ponytail"]);
  });
});

describe("decideSkillClose in strict mode (ADR-0138 addendum)", () => {
  it("a waiver discharges only the skills listed optional; the rest stay refused", () => {
    const strict = facts({ strict: true, optional: ["ponytail-review"] });
    const text = `${SCOPE_MET}\nSkill not used: ponytail — one-line edit\nSkill not used: ponytail-review — same`;
    const r = decideSkillClose(text, strict);
    expect(r.waived).toEqual(["ponytail-review"]);
    expect(r.block?.reason).toContain("`ponytail`");
    expect(r.block?.reason).not.toContain("Run `Skill { skill: \"ponytail-review\" }`");
    expect(r.block?.reason).toContain("Practice pane");
    expect(r.block?.reason).not.toContain("is accepted");
  });

  it("closes when every missing skill is optional and waived", () => {
    const r = decideSkillClose(`${SCOPE_MET}\nSkill not used: ponytail — not needed\nSkill not used: ponytail-review — not needed`, facts({ strict: true, optional: ["ponytail", "ponytail-review"] }));
    expect(r.block).toBeNull();
    expect(r.waived).toEqual(["ponytail", "ponytail-review"]);
  });

  it("strict off (or absent) keeps today's behaviour: any waiver discharges any skill", () => {
    const text = `${SCOPE_MET}\nSkill not used: ponytail — not needed\nSkill not used: ponytail-review — not needed`;
    expect(decideSkillClose(text, facts()).block).toBeNull();
    expect(decideSkillClose(text, facts({ strict: false, optional: [] })).block).toBeNull();
  });
});

describe("the skills Stop hook", () => {
  const prev = process.env.MARVIN_DESIGN_HOOKS;
  const base: TurnCloseFacts = { mutations: 0, lastTodos: undefined, machineTurn: false, alreadyFired: false };
  const call = (hook: ReturnType<typeof makeTurnCloseStopHook>, text: string, active = false) =>
    hook(
      { hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: text, session_id: "s", transcript_path: "", cwd: "/" } as never,
      undefined,
      { signal: new AbortController().signal },
    ) as Promise<{ decision?: string; reason?: string }>;
  /** A session record the hook reads through `skills()` and writes through `onSkillBlock()`, like the meta does. */
  function session(initial: Partial<SkillCloseFacts> = {}, over: Partial<TurnCloseFacts> = {}) {
    const state = facts(initial);
    const blocked = vi.fn(() => {
      state.blocks += 1;
    });
    const hook = makeTurnCloseStopHook({
      turnId: "t",
      facts: () => ({ ...base, ...over }),
      skills: () => state,
      onSkillBlock: blocked,
      onFired: () => {},
    });
    return { state, blocked, hook };
  }

  beforeEach(() => {
    delete process.env.MARVIN_DESIGN_HOOKS;
    ensureBuiltinRules();
    updateRule("builtin:skills-named", { tier: "deny", status: "active" });
    __resetBuiltinCacheForTests();
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.MARVIN_DESIGN_HOOKS;
    else process.env.MARVIN_DESIGN_HOOKS = prev;
  });

  it("has a built-in row, native tier deny, that the Practice pane can lower", () => {
    expect(BUILTIN_RULE_IDS).toContain("builtin:skills-named");
    expect(readRules().find((r) => r.id === "builtin:skills-named")?.tier).toBe("deny");
  });

  it("blocks a scope-met close, brakes after two blocks, then lets it through", async () => {
    const { hook, blocked } = session();
    const first = await call(hook, SCOPE_MET);
    expect(first.decision).toBe("block");
    expect(first.reason).toContain("`ponytail`");
    expect((await call(hook, SCOPE_MET)).decision).toBe("block");
    expect(await call(hook, SCOPE_MET)).toEqual({});
    expect(blocked).toHaveBeenCalledTimes(2);
  });

  it("strict mode has no brake: the third, fourth and later closes still refuse", async () => {
    const { hook } = session({ strict: true, optional: [] });
    for (let i = 0; i < 5; i += 1) expect((await call(hook, SCOPE_MET)).decision, `close ${i + 1}`).toBe("block");
    // Blocks already counted on the record (a restart) do not release it either.
    expect((await call(session({ strict: true, optional: [], blocks: 9 }).hook, SCOPE_MET)).decision).toBe("block");
  });

  it("strict mode: a waiver for a non-optional skill does not close, an optional one does; a machine turn is still checked", async () => {
    const all = ["ponytail", "ponytail-review"].map((n) => `Skill not used: ${n} — not needed`).join("\n");
    expect((await call(session({ strict: true, optional: ["ponytail-review"] }).hook, `${SCOPE_MET}\n${all}`)).decision).toBe("block");
    expect(await call(session({ strict: true, optional: ["ponytail", "ponytail-review"] }).hook, `${SCOPE_MET}\n${all}`)).toEqual({});
    expect((await call(session({ strict: true, optional: [] }, { machineTurn: true }).hook, `${SCOPE_MET}\n${all}`)).decision).toBe("block");
  });

  it("strict mode still yields to the user: a lowered or retired Practice row does not block", async () => {
    updateRule("builtin:skills-named", { tier: "nudge" });
    __resetBuiltinCacheForTests();
    expect(await call(session({ strict: true, optional: [] }).hook, SCOPE_MET)).toEqual({});
    updateRule("builtin:skills-named", { tier: "deny", status: "retired" });
    __resetBuiltinCacheForTests();
    expect(await call(session({ strict: true, optional: [] }).hook, SCOPE_MET)).toEqual({});
  });

  it("the brake survives a restart: blocks already counted on the record are not forgotten", async () => {
    const { hook, blocked } = session({ blocks: 2 });
    expect(await call(hook, SCOPE_MET)).toEqual({});
    expect(blocked).not.toHaveBeenCalled();
  });

  it("accepts the waiver line instead of blocking", async () => {
    const { hook, blocked } = session();
    const text = `${SCOPE_MET}\nSkill not used: ponytail — one-line edit\nSkill not used: ponytail-review — same`;
    expect(await call(hook, text)).toEqual({});
    expect(blocked).not.toHaveBeenCalled();
  });

  it("checks a machine turn that claims scope met: a long-running tab closes on its wakeup turn", async () => {
    // Measured 2026-11-27, agri-saas: of 8 tabs seeded with 12 skills, every
    // scope-met close was a `[scheduled wakeup ...]` turn; the first, human
    // turn said "Scope is not met". The gate skipped machine turns, so it never
    // fired (blocks: none) while 5 to 11 named skills had not run.
    const { hook, blocked } = session({}, { machineTurn: true });
    const r = await call(hook, SCOPE_MET);
    expect(r.decision).toBe("block");
    expect(r.reason).toContain("`ponytail`");
    expect(blocked).toHaveBeenCalledTimes(1);
  });

  it("ignores turns that do not claim scope met, and a session with no seeded list", async () => {
    expect(await call(session({}, { machineTurn: true }).hook, "Waiting on the job.")).toEqual({});
    expect(await call(session().hook, "Working on step 2.")).toEqual({});
    const noList = makeTurnCloseStopHook({ turnId: "t", facts: () => ({ ...base }), skills: () => null, onFired: () => {} });
    expect(await call(noList, SCOPE_MET)).toEqual({});
  });

  it("a read failure never blocks a close", async () => {
    const hook = makeTurnCloseStopHook({
      turnId: "t",
      facts: () => ({ ...base }),
      skills: () => {
        throw new Error("meta unreadable");
      },
      onFired: () => {},
    });
    expect(await call(hook, SCOPE_MET)).toEqual({});
  });

  it("is a gate, not a once-per-turn advisory: it still blocks under stop_hook_active", async () => {
    expect((await call(session().hook, SCOPE_MET, true)).decision).toBe("block");
  });

  it("measure mode only records; a retired row switches it off; nudge tier never blocks", async () => {
    process.env.MARVIN_DESIGN_HOOKS = "measure";
    expect(await call(session().hook, SCOPE_MET)).toEqual({});
    delete process.env.MARVIN_DESIGN_HOOKS;

    updateRule("builtin:skills-named", { tier: "nudge" });
    __resetBuiltinCacheForTests();
    expect(await call(session().hook, SCOPE_MET)).toEqual({});

    updateRule("builtin:skills-named", { tier: "deny", status: "retired" });
    __resetBuiltinCacheForTests();
    expect(await call(session().hook, SCOPE_MET)).toEqual({});
  });

  it("logs block, waived and bypass as telemetry", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const kinds = () => log.mock.calls.map((c) => (JSON.parse(String(c[0]).replace("[marvin.telemetry] ", "")) as { kind: string }).kind);
    const { hook } = session();
    await call(hook, SCOPE_MET);
    await call(hook, `${SCOPE_MET}\nSkill not used: ponytail — trivial\nSkill not used: ponytail-review — trivial`);
    await call(hook, SCOPE_MET);
    await call(hook, SCOPE_MET);
    const seen = kinds();
    log.mockRestore();
    expect(seen).toEqual(["skills.close.block", "skills.close.waived", "skills.close.block", "skills.close.bypass"]);
  });
});

// A Skill call as the SDK names it, from a real transcript (agri-saas 2026-11-27):
// {"type":"tool_use","name":"Skill","input":{"skill":"marvin-project-local:ponytail"}}.
// It lands in the session meta (`skillsRun`) and from there in the close facts
// and the watch row's `skills.used`; `used` is derived, never a meta field.
describe("a real Skill tool_use reaches the meta and the close facts", () => {
  it("records the namespaced name once and reads it back as used", async () => {
    const { createTurnDesignContext, recordAllowedTool } = await import("../src/design-hooks");
    const { readSessionMeta, upsertSessionMeta } = await import("../src/session-meta");
    const { seedTurnSkills, skillCloseFacts } = await import("../src/skill-brief");
    const posture = { model: "m", advisorModel: null, personality: "marvin" as const, permissionStrategy: "auto" as const, thinkingMode: "high" };
    const root = mkdtempSync(join(tmpdir(), "marvin-skills-close-root-"));
    upsertSessionMeta("p-real", "s-real", { workDir: root, tree: { mode: "shared" }, posture });
    seedTurnSkills({ projectId: "p-real", sessionId: "s-real", message: "Skills: `ponytail`, `ux-review`, `pr-review`", turnId: "t", isFirstTurn: () => true, workDir: root });
    const ctx = createTurnDesignContext("turn-1", root, { spineSession: { projectId: "p-real", sessionId: "s-real" } });
    recordAllowedTool(ctx, "Skill", { skill: "marvin-project-local:ponytail" });
    recordAllowedTool(ctx, "Skill", { skill: "ux-review-toolkit:UX-Review", args: "x" });
    recordAllowedTool(ctx, "Skill", { skill: "marvin-project-local:ponytail" });
    expect(readSessionMeta("p-real", "s-real")?.skillsRun).toEqual(["ponytail", "ux-review"]);
    const f = skillCloseFacts("p-real", "s-real", root);
    expect(f?.used).toEqual(["ponytail", "ux-review"]);
    expect(f && decideSkillClose(SCOPE_MET, f).block?.reason).toContain("`pr-review`");
  });
});
