// ADR-0107 — turns a restart cut off. Pins the tail scan (the newest of
// turn.started / turn.completed / turn.error decides), the idempotent boot
// marker, the resume record built from the persisted posture, and that a
// session with a live turn is never reported as interrupted.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { marvinPaths } from "../src/paths";
import { addProject } from "../src/projects";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import { buildResumeRecord, 
  classifyTurnFailure,findInterruptedSessions, 
  INTERRUPTED_BY_SHUTDOWN_MESSAGE,markInterruptedAtBoot, scanTail,
} from "../src/session-recovery";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";

// A cut-off turn counts as interrupted only inside a recent window (addendum
// 2), so the default start time is "a minute ago", never a fixed date.
const RECENT_START = new Date(Date.now() - 60_000).toISOString();
const started = (turnId: string, at = RECENT_START) =>
  JSON.stringify({ type: "turn.started", at, marvinSessionId: "s", projectId: "p", model: "claude-sonnet-5", advisorModel: "claude-fable-5-1", runtimeMode: "opus", personality: "ultron", permissionStrategy: "auto", thinkingMode: "max", turnId });
const completed = (at = "2026-09-08T23:11:36.111Z") => JSON.stringify({ type: "turn.completed", at, durationMs: 1, costUsd: 0.1, tokenUsage: null, sessionId: "sdk" });
const user = (message: string) => JSON.stringify({ type: "turn.user", at: "2026-09-08T23:10:00.000Z", message });
const noise = JSON.stringify({ type: "cli.event", at: "2026-09-08T23:10:08.000Z", event: { type: "assistant" } });

describe("scanTail", () => {
  it("a trailing turn.started with no terminal is a cut-off turn", () => {
    const scan = scanTail([user("do the thing"), started("t1"), noise, noise].join("\n") + "\n");
    expect(scan.newest).toBe("turn.started");
    expect(scan.started?.turnId).toBe("t1");
    expect(scan.lastUserMessage).toBe("do the thing");
    expect(scan.markedInterrupted).toBe(false);
  });
  it("a terminal after the start is a finished turn; a truncated last line is tolerated", () => {
    expect(scanTail([started("t1"), completed()].join("\n")).newest).toBe("turn.completed");
    expect(scanTail([started("t1"), completed(), '{"type":"turn.sta'].join("\n")).newest).toBe("turn.completed");
    const marked = scanTail([started("t1"), JSON.stringify({ type: "turn.error", at: "x", error: "interrupted", interrupted: true })].join("\n"));
    expect(marked.newest).toBe("turn.error");
    expect(marked.markedInterrupted).toBe(true);
  });
});

describe("classifyTurnFailure", () => {
  // Addendum 3 — the SDK text is identical for Stop and for an external kill.
  it("an external SIGTERM is an interruption; a user Stop and other errors stay as they are", () => {
    const sigterm = "Turn cancelled (subprocess received SIGTERM — usually Stop / ⌘.).";
    expect(classifyTurnFailure(sigterm, false)).toEqual({ error: INTERRUPTED_BY_SHUTDOWN_MESSAGE, interrupted: true });
    expect(classifyTurnFailure("claude exited with code 143", false).interrupted).toBe(true);
    expect(classifyTurnFailure(sigterm, true)).toEqual({ error: sigterm, interrupted: false });
    expect(classifyTurnFailure("socket hang up", false)).toEqual({ error: "socket hang up", interrupted: false });
  });
});

describe("recovery on disk", () => {
  let dataDir: string;
  let workDir: string;
  let projectId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "marvin-recovery-"));
    process.env.MARVIN_DATA_DIR = dataDir;
    workDir = mkdtempSync(path.join(tmpdir(), "marvin-recovery-proj-"));
    projectId = addProject({ workDir }).id;
  });

  afterEach(() => {
    delete process.env.MARVIN_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  function transcript(id: string, lines: string[]) {
    const p = marvinPaths.sessionFile(projectId, id);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, lines.join("\n") + "\n");
  }

  it("finds cut-off sessions, skips finished and live ones, and marks idempotently", () => {
    transcript("cut", [user("resume me"), started("t-cut")]);
    transcript("done", [user("x"), started("t-done"), completed()]);
    transcript("live", [user("y"), started("t-live")]);
    const live = registerLiveTurn({ turnId: "t-live", marvinSessionId: "live", projectId });
    try {
      const found = findInterruptedSessions(projectId);
      expect(found.map((s) => s.marvinSessionId)).toEqual(["cut"]);
      expect(found[0]?.turnId).toBe("t-cut");
      expect(found[0]?.lastUserMessage).toBe("resume me");
      expect(found[0]?.posture?.model).toBe("claude-sonnet-5");

      expect(markInterruptedAtBoot()).toEqual({ marked: 1 });
      const text = readFileSync(marvinPaths.sessionFile(projectId, "cut"), "utf8");
      expect(text).toContain('"interrupted":true');
      // A meta was created from the transcript's posture, with the outcome.
      expect(readSessionMeta(projectId, "cut")?.lastTurn?.outcome).toBe("interrupted");
      // Second boot: nothing new to mark, but the session still lists as interrupted.
      expect(markInterruptedAtBoot()).toEqual({ marked: 0 });
      expect(findInterruptedSessions(projectId, { includeMarked: true }).map((s) => s.marvinSessionId)).toEqual(["cut"]);
      expect(findInterruptedSessions(projectId)).toEqual([]);
    } finally {
      endLiveTurn(live, { event: "turn.completed", data: {} });
    }
  });

  // ADR-0107 addendum 2 — a dangling turn.started from months ago is not an
  // interruption anyone resumes; the first boot with the marker flagged nine.
  it("ignores cut-off turns older than the window, and the boot marker leaves them alone", () => {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const startedOld = JSON.stringify({ ...JSON.parse(started("t-old")), at: old });
    transcript("ancient", [user("long ago"), startedOld]);
    transcript("fresh", [user("just now"), started("t-fresh")]);
    expect(findInterruptedSessions(projectId).map((s) => s.marvinSessionId)).toEqual(["fresh"]);
    expect(findInterruptedSessions(projectId, { maxAgeMs: 365 * 24 * 3600 * 1000 }).map((s) => s.marvinSessionId).sort()).toEqual(["ancient", "fresh"]);
    expect(markInterruptedAtBoot()).toEqual({ marked: 1 });
    expect(readFileSync(marvinPaths.sessionFile(projectId, "ancient"), "utf8")).not.toContain('"interrupted":true');
  });

  it("builds a resume record from the meta's posture and tree", () => {
    const meta = upsertSessionMeta(projectId, "r", {
      workDir,
      tree: { mode: "shared" },
      posture: { model: "m", advisorModel: "a", personality: "ultron", permissionStrategy: "gated", thinkingMode: "high", playwrightEnabled: true },
    }, { lastTurn: { turnId: "t-abc12345", startedAt: "2026-09-08T23:10:07.205Z", outcome: "interrupted" } })!;
    const rec = buildResumeRecord(meta, { now: 1000 });
    expect(rec).toMatchObject({
      marvinSessionId: "r",
      projectId,
      cwd: workDir,
      workDir,
      model: "m",
      advisorModel: "a",
      permissionStrategy: "gated",
      playwrightEnabled: true,
      reason: "resume after restart",
      depth: 0,
      fireAt: 1000,
    });
    expect(rec.prompt).toContain("t-abc123");
    expect(rec.prompt).toContain("git status");
  });
});
