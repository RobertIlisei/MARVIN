import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readLedger } from "../src/supervisor-ledger";
import {
  applySupervisorAction,
  bootSupervisor,
  categoryMode,
  currentSupervisorToken,
  getSupervisorState,
  noteSupervisorTabSpend,
  onSupervisorControl,
  resetSupervisorStateForTests,
  supervisorDir,
} from "../src/supervisor-state";

// ADR-0127 milestone 4 — autonomy is switched per category by the user. The
// state carries it, the mode is derived from it, every change bumps the
// revision, and the brief's §10.1 mutations exist.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const act = (body: Record<string, unknown>) => applySupervisorAction({ projectId: "proj", ...body }, token());

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m4-state-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("per-category autonomy", () => {
  it("starts with every category in shadow, and the mode reads shadow", () => {
    act({ action: "start" });
    const s = getSupervisorState("proj");
    expect(s.autonomy).toEqual({ questions: "shadow", nudges: "shadow", posture: "shadow", confirms: "shadow" });
    expect(s.mode).toBe("shadow");
  });

  it("switching one category to autonomous derives mode autonomous; only that category acts", () => {
    act({ action: "start" });
    const r = act({ action: "autonomy", category: "questions", value: "autonomous" });
    expect(r.ok).toBe(true);
    const s = getSupervisorState("proj");
    expect(s.mode).toBe("autonomous");
    expect(categoryMode(s, "questions")).toBe("autonomous");
    expect(categoryMode(s, "nudges")).toBe("shadow");
    act({ action: "autonomy", category: "questions", value: "shadow" });
    expect(getSupervisorState("proj").mode).toBe("shadow");
  });

  it("refuses confirms autonomy until milestone 5, and an unknown category or value", () => {
    act({ action: "start" });
    const c = act({ action: "autonomy", category: "confirms", value: "autonomous" });
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.status).toBe(409);
    expect(act({ action: "autonomy", category: "merges", value: "autonomous" }).ok).toBe(false);
    expect(act({ action: "autonomy", category: "questions", value: "yes" }).ok).toBe(false);
    expect(getSupervisorState("proj").autonomy.confirms).toBe("shadow");
  });

  it("refuses autonomy while the supervisor is off; every category reads off then", () => {
    const r = act({ action: "autonomy", category: "questions", value: "autonomous" });
    expect(r.ok).toBe(false);
    expect(categoryMode(getSupervisorState("proj"), "questions")).toBe("off");
  });

  it("a switch is ledgered as the user's control line", () => {
    act({ action: "start" });
    act({ action: "autonomy", category: "posture", value: "autonomous" });
    const line = readLedger("proj").find((e) => e.verb === "autonomy");
    expect(line?.kind).toBe("control");
    expect(line?.reason).toContain("posture=autonomous");
  });

  it("autonomy survives a restart; start and disable put every category back to shadow", () => {
    act({ action: "start" });
    act({ action: "autonomy", category: "nudges", value: "autonomous" });
    bootSupervisor();
    expect(getSupervisorState("proj").autonomy.nudges).toBe("autonomous");
    expect(getSupervisorState("proj").mode).toBe("autonomous");
    act({ action: "disable" });
    expect(getSupervisorState("proj").mode).toBe("off");
    act({ action: "start" });
    expect(getSupervisorState("proj").autonomy.nudges).toBe("shadow");
  });

  it("a file that says shadow boots shadow, whatever its categories say", () => {
    act({ action: "start" });
    const file = path.join(supervisorDir("proj"), "state.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.mode = "shadow";
    raw.autonomy = { questions: "autonomous", nudges: "autonomous", posture: "shadow", confirms: "shadow" };
    writeFileSync(file, JSON.stringify(raw));
    bootSupervisor();
    expect(getSupervisorState("proj").mode).toBe("shadow");
    expect(getSupervisorState("proj").autonomy.questions).toBe("shadow");
  });

  it("autonomy restored at boot is ledgered as a boot line naming the categories", () => {
    act({ action: "start" });
    act({ action: "autonomy", category: "questions", value: "autonomous" });
    bootSupervisor();
    const boot = readLedger("proj").filter((e) => e.verb === "boot");
    expect(boot).toHaveLength(1);
    expect(boot[0]?.reason).toContain("questions");
  });

  it("a hand-edited file cannot switch confirms on", () => {
    act({ action: "start" });
    const file = path.join(supervisorDir("proj"), "state.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.mode = "autonomous";
    raw.autonomy = { questions: "autonomous", nudges: "nonsense", posture: "shadow", confirms: "autonomous" };
    writeFileSync(file, JSON.stringify(raw));
    bootSupervisor();
    const s = getSupervisorState("proj");
    expect(s.autonomy).toEqual({ questions: "autonomous", nudges: "shadow", posture: "shadow", confirms: "shadow" });
  });
});

describe("revision and the brief's §10.1 mutations", () => {
  it("every state change increments the revision", () => {
    act({ action: "start" });
    const r1 = getSupervisorState("proj").revision;
    act({ action: "charter", text: "Postgres." });
    const r2 = getSupervisorState("proj").revision;
    expect(r2).toBeGreaterThan(r1);
    bootSupervisor();
    expect(getSupervisorState("proj").revision).toBe(r2);
  });

  it("start takes the set-up sheet: charter, cap and delegations in one call", () => {
    const r = act({ action: "start", charter: "Billing.", capUsd: 4, delegations: [{ sessionId: "tab-1", level: "answer-questions" }, { sessionId: "tab-2", level: "observe" }] });
    expect(r.ok).toBe(true);
    const s = getSupervisorState("proj");
    expect(s.charter).toBe("Billing.");
    expect(s.charterUpdatedAt).not.toBeNull();
    expect(s.caps.dailyBudgetUsd).toBe(4);
    expect(s.delegation).toEqual({ "tab-1": "answer-questions", "tab-2": "observe" });
  });

  it("start refuses a bad delegation without changing anything", () => {
    const r = act({ action: "start", delegations: [{ sessionId: "tab-1", level: "everything" }] });
    expect(r.ok).toBe(false);
    expect(getSupervisorState("proj").mode).toBe("off");
  });

  it("cap sets the daily budget, persists it, and refuses nonsense", () => {
    act({ action: "start" });
    expect(act({ action: "cap", capUsd: 25 }).ok).toBe(true);
    bootSupervisor();
    expect(getSupervisorState("proj").caps.dailyBudgetUsd).toBe(25);
    expect(act({ action: "cap", capUsd: -1 }).ok).toBe(false);
    expect(act({ action: "cap", capUsd: "lots" }).ok).toBe(false);
    expect(act({ action: "cap", capUsd: 100_000 }).ok).toBe(false);
  });

  it("disable is the brief's name for stop", () => {
    act({ action: "start" });
    expect(act({ action: "disable" }).ok).toBe(true);
    expect(getSupervisorState("proj").mode).toBe("off");
  });

  it("resume is refused while over the budget, and allowed once the cap is raised", () => {
    act({ action: "start", capUsd: 1 });
    noteSupervisorTabSpend("proj", 2);
    expect(getSupervisorState("proj").pause?.reason).toBe("budget");
    const r = act({ action: "resume" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
    act({ action: "cap", capUsd: 5 });
    expect(act({ action: "resume" }).ok).toBe(true);
    expect(getSupervisorState("proj").paused).toBe(false);
  });

  it("wakeNow resumes a user pause and tells the loop", () => {
    act({ action: "start" });
    act({ action: "pause" });
    const seen: string[] = [];
    const off = onSupervisorControl((e) => seen.push(e.action));
    expect(act({ action: "wakeNow" }).ok).toBe(true);
    off();
    expect(getSupervisorState("proj").paused).toBe(false);
    expect(seen).toEqual(["wakeNow"]);
  });

  it("wakeNow is refused while the supervisor is off", () => {
    expect(act({ action: "wakeNow" }).ok).toBe(false);
  });
});
