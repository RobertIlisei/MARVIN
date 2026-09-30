/**
 * ADR-0124 D — the sidecar seeds a checklist tab's plan spine, the gate keeps
 * it current, provable steps tick themselves, and a scope-met close with a
 * seeded step still open is refused.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_GATE_MAX_DENIES,
  createTurnDesignContext,
  type DesignTurnContext,
  recordAllowedTool,
  resetPlanSpineGateState,
  runDesignHooks,
} from "../src/design-hooks";
import {
  autoTickSpine,
  commandTickKind,
  mergeClientPlanState,
  parseChecklist,
  seededOpenSteps,
  seededSpineReminder,
  seedSpineFromMessage,
  seedTurnSpine,
} from "../src/plan-seed";
import { applyTodosToSpine } from "../src/plan-spine";
import { readPlanState, writePlanState } from "../src/plan-state";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { decideSeededClose, makeTurnCloseStopHook } from "../src/turn-close-hook";

const PROJECT = "seed-proj";
const SESSION = "seed-sess";

const BRIEF = `Work in ~/repo. Build the thing.

## What to build
A. Some context that is not a step.

## Definition of Done
- The design hook denies Bash source reads before a graph call
- In a worktree tab, graph_search finds a tab-added symbol
- Run the tests until green
- Playwright e2e suite passes
- Merge the branch into main
`;

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plan-seed-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetPlanSpineGateState();
});
afterEach(() => {
  delete process.env.MARVIN_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("parseChecklist", () => {
  it("reads a Definition of Done list", () => {
    expect(parseChecklist(BRIEF)).toEqual([
      "The design hook denies Bash source reads before a graph call",
      "In a worktree tab, graph_search finds a tab-added symbol",
      "Run the tests until green",
      "Playwright e2e suite passes",
      "Merge the branch into main",
    ]);
  });

  it("prefers an explicit Steps section over criteria, and skips nested bullets and checkboxes", () => {
    const msg = [
      "**Steps**",
      "1. [ ] **Tracer slice** — wire the route",
      "   - a sub-bullet that is not a step",
      "2. Widen to the other layers",
      "",
      "Done when:",
      "- it works",
      "- it is tested",
    ].join("\n");
    expect(parseChecklist(msg)).toEqual(["Tracer slice — wire the route", "Widen to the other layers"]);
  });

  it("a bare numbered list is a checklist; a chore is not", () => {
    expect(parseChecklist("Please:\n1. bump the version\n2. redeploy dev")).toEqual(["bump the version", "redeploy dev"]);
    expect(parseChecklist("redeploy dev please")).toBeNull();
    expect(parseChecklist("- just one bullet\n")).toBeNull();
    expect(parseChecklist("Can you check:\n- the logs\n- the build")).toBeNull(); // unheaded bullets: prose, not a plan
  });
});

describe("seeding", () => {
  it("a checklist message seeds [1]…[N] pending steps, marks the session, and reminds with the ordinals", () => {
    upsertSessionMeta(PROJECT, SESSION, {
      workDir: "/x",
      tree: { mode: "shared" },
      posture: { model: "m", advisorModel: null, personality: "ultron", permissionStrategy: "auto", thinkingMode: "high" },
    });
    const r = seedTurnSpine({ projectId: PROJECT, sessionId: SESSION, message: BRIEF, turnId: "t1" });
    expect(r.seeded).toBe(true);
    const ps = readPlanState(PROJECT, SESSION);
    expect(ps.ok && seededOpenSteps(ps.state)).toEqual([
      "[1] The design hook denies Bash source reads before a graph call",
      "[2] In a worktree tab, graph_search finds a tab-added symbol",
      "[3] Run the tests until green",
      "[4] Playwright e2e suite passes",
      "[5] Merge the branch into main",
    ]);
    expect(readSessionMeta(PROJECT, SESSION)?.checklist).toMatchObject({ steps: 5, planId: r.planId });
    const reminder = ps.ok ? seededSpineReminder(ps.state, true) : null;
    expect(reminder).toContain("[3] Run the tests until green");
    expect(reminder).toContain("TodoWrite");
  });

  it("the seeded spine joins a tagged TodoWrite by ordinal (ADR-0116 projection)", () => {
    seedSpineFromMessage(PROJECT, SESSION, BRIEF);
    const ps = readPlanState(PROJECT, SESSION);
    const applied = applyTodosToSpine(ps.ok ? ps.state : null, [
      { content: "[1] hook denies bash reads", status: "completed" },
      { content: "[2] worktree graph", status: "in_progress" },
    ], "2026-09-30T10:00:00.000Z");
    expect(applied.joined).toBe(true);
    expect(seededOpenSteps(applied.state)).toHaveLength(4);
  });

  it("a chore seeds nothing; a wakeup never seeds; an open plan is never replaced", () => {
    expect(seedTurnSpine({ projectId: PROJECT, sessionId: SESSION, message: "redeploy dev", turnId: "t" }).seeded).toBe(false);
    expect(readPlanState(PROJECT, SESSION)).toEqual({ ok: true, state: null });
    expect(seedTurnSpine({ projectId: PROJECT, sessionId: SESSION, message: `[scheduled wakeup — x]\n\n${BRIEF}`, turnId: "t" }).seeded).toBe(false);
    expect(seedSpineFromMessage(PROJECT, SESSION, BRIEF).seeded).toBe(true);
    expect(seedSpineFromMessage(PROJECT, SESSION, "1. another\n2. plan").reason).toContain("open steps");
  });

  it("the runner seeds before the SDK query starts — before any tool call can happen", () => {
    const src = readFileSync(join(__dirname, "..", "src", "sdk-runner.ts"), "utf8");
    const seedAt = src.indexOf("seedTurnSpine({");
    const queryAt = src.indexOf("query({");
    expect(seedAt).toBeGreaterThan(0);
    expect(queryAt).toBeGreaterThan(seedAt);
  });
});

describe("plan-spine commit gate", () => {
  function ctx(): DesignTurnContext {
    return createTurnDesignContext(`t-${Math.random()}`, dataDir, { spineSession: { projectId: PROJECT, sessionId: SESSION } });
  }
  const commit = { command: 'git commit -m "x"' };
  function tryCommit(c: DesignTurnContext) {
    const deny = runDesignHooks({ ctx: c, toolName: "Bash", toolInput: commit, mode: "enforce" });
    if (!deny) recordAllowedTool(c, "Bash", commit);
    return deny;
  }

  it("denies a second commit with no TodoWrite in between, and allows after one", () => {
    seedSpineFromMessage(PROJECT, SESSION, BRIEF);
    const c = ctx();
    expect(tryCommit(c)).toBeNull(); // the first commit always passes
    const deny = tryCommit(c);
    expect(deny?.message).toContain("plan-spine gate (ADR-0124)");
    expect(deny?.message).toContain("TodoWrite");
    recordAllowedTool(c, "TodoWrite", { todos: [{ content: "[1] x", status: "completed" }] });
    expect(tryCommit(c)).toBeNull();
  });

  it(`allows and logs after ${BUILTIN_GATE_MAX_DENIES} denies in one turn`, () => {
    seedSpineFromMessage(PROJECT, SESSION, BRIEF);
    const c = ctx();
    expect(tryCommit(c)).toBeNull();
    expect(tryCommit(c)).not.toBeNull();
    expect(tryCommit(c)).not.toBeNull();
    expect(tryCommit(c)).toBeNull();
  });

  it("the state spans turns of the same tab, and a tab with no seeded plan is never gated", () => {
    seedSpineFromMessage(PROJECT, SESSION, BRIEF);
    expect(tryCommit(ctx())).toBeNull();
    expect(tryCommit(ctx())).not.toBeNull(); // next turn, still no TodoWrite
    const other = createTurnDesignContext("t-o", dataDir, { spineSession: { projectId: PROJECT, sessionId: "chore" } });
    expect(tryCommit(other)).toBeNull();
    expect(tryCommit(other)).toBeNull();
  });
});

describe("scope-met with pending seeded steps", () => {
  const close = "All done.\n\n**Scope met:** everything. Anything else, or should I stop?\n<!-- marvin:scope-met -->";

  it("is refused while a seeded step is open, and not once all are reconciled", () => {
    expect(decideSeededClose(close, ["[3] Run the tests until green"])?.kind).toBe("seeded-steps-open");
    expect(decideSeededClose(close, [])).toBeNull();
    expect(decideSeededClose("Still working on [3].", ["[3] x"])).toBeNull();
  });

  it("blocks twice, then lets the close through (ADR-0104 brake) — even inside the SDK's continuation", async () => {
    const hook = makeTurnCloseStopHook({
      turnId: "t",
      facts: () => ({ mutations: 0, lastTodos: undefined, machineTurn: true, seededOpenSteps: ["[5] Merge"] }),
      onFired: () => {},
    });
    const stop = (active: boolean) =>
      hook({ hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: close } as never, undefined, { signal: new AbortController().signal });
    expect(await stop(false)).toMatchObject({ decision: "block" });
    expect(await stop(true)).toMatchObject({ decision: "block" });
    expect(await stop(true)).toEqual({});
  });
});

describe("auto-tick", () => {
  it("maps commands to the step kind they prove", () => {
    expect(commandTickKind("cd apps/web && npx playwright test tests/e2e")).toBe("playwright");
    expect(commandTickKind("make fast-band")).toBe("fast-band");
    expect(commandTickKind("pnpm -C sidecar test")).toBe("tests");
    expect(commandTickKind("npx vitest run src")).toBe("tests");
    expect(commandTickKind("pnpm build")).toBeNull();
  });

  it("a green test run ticks the one tests step — not the Playwright one", () => {
    seedSpineFromMessage(PROJECT, SESSION, BRIEF);
    expect(autoTickSpine(PROJECT, SESSION, { kind: "job", command: "npx vitest run" })).toEqual({ ticked: 3, reason: "tests" });
    expect(autoTickSpine(PROJECT, SESSION, { kind: "job", command: "npx playwright test" })).toEqual({ ticked: 4, reason: "playwright" });
    expect(autoTickSpine(PROJECT, SESSION, { kind: "merge" })).toEqual({ ticked: 5, reason: "merge" });
    const ps = readPlanState(PROJECT, SESSION);
    expect(ps.ok && seededOpenSteps(ps.state)).toHaveLength(2);
    // The watermark is a TodoWrite's, not an auto-tick's.
    expect(ps.ok && (ps.state as { lastTodoAt?: string }).lastTodoAt).not.toBeUndefined();
  });

  it("refuses to guess: two candidate steps, or none, tick nothing", () => {
    seedSpineFromMessage(PROJECT, SESSION, "## Steps\n1. unit tests for the parser\n2. unit tests for the gate\n3. write docs");
    expect(autoTickSpine(PROJECT, SESSION, { kind: "job", command: "pnpm test" }).ticked).toBeNull();
    expect(autoTickSpine(PROJECT, SESSION, { kind: "merge" }).ticked).toBeNull();
    const ps = readPlanState(PROJECT, SESSION);
    expect(ps.ok && seededOpenSteps(ps.state)).toHaveLength(3);
  });

  it("never touches a plan MARVIN did not seed", () => {
    writePlanState(PROJECT, SESSION, { activePlanId: "p", plans: [{ id: "p", steps: [{ content: "run tests", status: "pending" }] }] });
    expect(autoTickSpine(PROJECT, SESSION, { kind: "job", command: "pnpm test" })).toEqual({ ticked: null, reason: "no seeded plan" });
  });
});

describe("client saves", () => {
  it("keep the seeded flag, and a seeded plan the client never saw", () => {
    seedSpineFromMessage(PROJECT, SESSION, BRIEF, "2026-09-30T09:00:00.000Z");
    const ps = readPlanState(PROJECT, SESSION);
    const seeded = ps.ok ? (ps.state as { plans: Array<{ id: string; steps: unknown[] }> }).plans[0]! : null;
    // The client re-encodes the plan without `seeded`.
    const echoed = { plans: [{ id: seeded!.id, title: "t", text: "", steps: seeded!.steps }], activePlanId: seeded!.id };
    const merged = mergeClientPlanState(ps.ok ? ps.state : null, echoed) as { plans: Array<{ seeded?: boolean }> };
    expect(merged.plans[0]?.seeded).toBe(true);
    // A client that never saw the seed saves its own plan: the seeded one survives.
    const blind = mergeClientPlanState(ps.ok ? ps.state : null, { plans: [{ id: "mine", steps: [] }], activePlanId: "mine", lastTodoAt: "2026-09-30T08:00:00.000Z" }) as { plans: Array<{ id: string }> };
    expect(blind.plans.map((p) => p.id)).toEqual(["mine", seeded!.id]);
    // One that did see it (watermark at/after the seed) may remove it.
    const removed = mergeClientPlanState(ps.ok ? ps.state : null, { plans: [], lastTodoAt: "2026-09-30T09:00:00.000Z" }) as { plans: unknown[] };
    expect(removed.plans).toEqual([]);
  });
});
