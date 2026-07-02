// ADR-0052 — durable per-session plan state. Pins the store's contract:
// identity hygiene (no path traversal), size cap, atomic round-trip, and
// the corrupt-file → "nothing stored" fallback that keeps hydration alive.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PLAN_STATE_MAX_BYTES,
  planStatePath,
  readPlanState,
  writePlanState,
} from "../src/plan-state";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-plan-state-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.MARVIN_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const STATE = {
  activePlanId: "fix-the-widget",
  plans: [
    {
      id: "fix-the-widget",
      title: "Fix the widget",
      text: "# Plan — Fix the widget\n1. step one",
      steps: [{ id: "step one", content: "step one", status: "in_progress", subtasks: [] }],
    },
  ],
};

describe("plan-state store (ADR-0052)", () => {
  it("round-trips a plan spine", () => {
    const w = writePlanState("proj-a", "sess-1", STATE);
    expect(w.ok).toBe(true);
    const r = readPlanState("proj-a", "sess-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toEqual(STATE);
  });

  it("returns state:null when nothing has been saved", () => {
    const r = readPlanState("proj-a", "never-saved");
    expect(r).toEqual({ ok: true, state: null });
  });

  it("rejects path-traversal ids on read AND write", () => {
    for (const bad of ["../escape", "a/b", "a\\b", "..", ""]) {
      expect(writePlanState(bad, "sess-1", STATE).ok).toBe(false);
      expect(writePlanState("proj-a", bad, STATE).ok).toBe(false);
      expect(readPlanState(bad, "sess-1").ok).toBe(false);
      expect(readPlanState("proj-a", bad).ok).toBe(false);
    }
  });

  it("rejects an over-cap payload", () => {
    const huge = { blob: "x".repeat(PLAN_STATE_MAX_BYTES) };
    const w = writePlanState("proj-a", "sess-2", huge);
    expect(w.ok).toBe(false);
  });

  it("rejects null / non-serializable state", () => {
    expect(writePlanState("proj-a", "sess-3", null).ok).toBe(false);
  });

  it("treats a corrupt file as nothing-stored (fallback to scrape, not a crash)", () => {
    writePlanState("proj-a", "sess-4", STATE);
    writeFileSync(planStatePath("proj-a", "sess-4"), "{not json", "utf8");
    const r = readPlanState("proj-a", "sess-4");
    expect(r).toEqual({ ok: true, state: null });
  });

  it("stores next to the transcript, one file per session", () => {
    writePlanState("proj-b", "sess-9", STATE);
    const p = planStatePath("proj-b", "sess-9");
    expect(p.endsWith(path.join("sessions", "proj-b", "sess-9.plans.json"))).toBe(true);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(STATE);
  });
});
