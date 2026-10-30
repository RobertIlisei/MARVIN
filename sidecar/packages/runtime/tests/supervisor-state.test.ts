import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { appendLedgerEntry, digestArgs, ledgerPath, readLedger } from "../src/supervisor-ledger";
import {
  applySupervisorAction,
  bootSupervisor,
  currentSupervisorToken,
  getSupervisorState,
  isSupervisorSessionId,
  resetSupervisorStateForTests,
  supervisorDir,
  supervisorTokenPath,
  verifySupervisorToken,
} from "../src/supervisor-state";

// ADR-0127 §3 / §5 / §6 — the supervisor's authority lives in the runtime,
// persists under the DATA dir only, is changed only through a token-bearing
// action, and every act lands in an append-only ledger beside it.

let dataDir: string;
let workDir: string;
const prevDataDir = process.env.MARVIN_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prevDataDir === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const token = () => currentSupervisorToken() as string;

describe("supervisor state — authority in the runtime, persisted under the data dir", () => {
  it("ships off: an unknown project has mode off and no delegation", () => {
    const s = getSupervisorState("proj");
    expect(s.mode).toBe("off");
    expect(s.delegation).toEqual({});
    expect(s.paused).toBe(false);
  });

  it("start puts it in shadow mode with its own session id, and persists 0600 under the data dir", () => {
    const r = applySupervisorAction({ projectId: "proj", action: "start" }, token());
    expect(r.ok).toBe(true);
    const s = getSupervisorState("proj");
    expect(s.mode).toBe("shadow");
    expect(s.supervisorSessionId).toMatch(/^[0-9a-f-]{36}$/);
    const file = path.join(supervisorDir("proj"), "state.json");
    expect(file.startsWith(dataDir)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses autonomous mode in milestone 1 — shadow is the only way on", () => {
    const r = applySupervisorAction({ projectId: "proj", action: "mode", mode: "autonomous" }, token());
    expect(r.ok).toBe(false);
    expect(getSupervisorState("proj").mode).toBe("off");
  });

  it("delegate validates the level and refuses the supervisor's own session as a target", () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    expect(applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "answer-questions" }, token()).ok).toBe(true);
    expect(getSupervisorState("proj").delegation["tab-1"]).toBe("answer-questions");
    expect(applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "everything" }, token()).ok).toBe(false);
    const own = getSupervisorState("proj").supervisorSessionId as string;
    expect(applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: own, level: "observe" }, token()).ok).toBe(false);
  });

  it("refuses a path-shaped project id", () => {
    expect(applySupervisorAction({ projectId: "../evil", action: "start" }, token()).ok).toBe(false);
    expect(() => supervisorDir("../evil")).toThrow();
  });

  it("every mutation requires the per-boot token; a wrong or missing token changes nothing", () => {
    expect(applySupervisorAction({ projectId: "proj", action: "start" }, undefined).ok).toBe(false);
    expect(applySupervisorAction({ projectId: "proj", action: "start" }, "nope").ok).toBe(false);
    expect(getSupervisorState("proj").mode).toBe("off");
  });

  it("before boot there is no token: verification fails closed and a refused request writes nothing", () => {
    resetSupervisorStateForTests();
    rmSync(supervisorTokenPath(), { force: true });
    expect(currentSupervisorToken()).toBeNull();
    expect(verifySupervisorToken("anything")).toBe(false);
    expect(applySupervisorAction({ projectId: "proj", action: "start" }, "anything").ok).toBe(false);
    expect(existsSync(supervisorTokenPath())).toBe(false);
  });

  it("the token file is 0600 under the data dir, and verification is exact", () => {
    const t = token();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(supervisorTokenPath(), "utf8").trim()).toBe(t);
    expect(statSync(supervisorTokenPath()).mode & 0o777).toBe(0o600);
    expect(verifySupervisorToken(t)).toBe(true);
    expect(verifySupervisorToken(`${t}x`)).toBe(false);
    expect(verifySupervisorToken("")).toBe(false);
  });

  it("boot regenerates the token and re-arms persisted state — the file is read only then", () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "observe" }, token());
    const before = token();
    resetSupervisorStateForTests();
    const stats = bootSupervisor();
    expect(stats.armed).toEqual(["proj"]);
    expect(getSupervisorState("proj").mode).toBe("shadow");
    expect(getSupervisorState("proj").delegation["tab-1"]).toBe("observe");
    expect(token()).not.toBe(before);

    // Edited on disk after boot: not re-read.
    const file = path.join(supervisorDir("proj"), "state.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.delegation["tab-1"] = "answer-confirms";
    writeFileSync(file, JSON.stringify(raw));
    expect(getSupervisorState("proj").delegation["tab-1"]).toBe("observe");
  });

  it("a hand-edited state file cannot widen anything at boot: unknown values fall back to the safe ones", () => {
    const dir = supervisorDir("proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify({ version: 1, projectId: "proj", mode: "autonomous", delegation: { a: "everything", b: "observe" } }),
    );
    bootSupervisor();
    const s = getSupervisorState("proj");
    expect(s.mode).toBe("off");
    expect(s.delegation).toEqual({ b: "observe" });
  });

  it("a .marvin/supervisor* file planted in the project is ignored", () => {
    mkdirSync(path.join(workDir, ".marvin", "supervisor"), { recursive: true });
    const planted = { version: 1, projectId: "proj", mode: "shadow", delegation: { "tab-1": "answer-confirms" } };
    writeFileSync(path.join(workDir, ".marvin", "supervisor.json"), JSON.stringify(planted));
    writeFileSync(path.join(workDir, ".marvin", "supervisor", "state.json"), JSON.stringify(planted));
    const prevCwd = process.cwd();
    process.chdir(workDir);
    try {
      bootSupervisor();
      const s = getSupervisorState("proj");
      expect(s.mode).toBe("off");
      expect(s.delegation).toEqual({});
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("knows the supervisor's own session id across projects, so the chat route can refuse it", () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    const own = getSupervisorState("proj").supervisorSessionId as string;
    expect(isSupervisorSessionId(own)).toBe(true);
    expect(isSupervisorSessionId("tab-1")).toBe(false);
  });

  it("pause and kill stop it without losing delegation", () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    applySupervisorAction({ projectId: "proj", action: "delegate", marvinSessionId: "tab-1", level: "observe" }, token());
    applySupervisorAction({ projectId: "proj", action: "pause" }, token());
    expect(getSupervisorState("proj").paused).toBe(true);
    applySupervisorAction({ projectId: "proj", action: "resume" }, token());
    expect(getSupervisorState("proj").paused).toBe(false);
    applySupervisorAction({ projectId: "proj", action: "kill" }, token());
    expect(getSupervisorState("proj").paused).toBe(true);
    expect(getSupervisorState("proj").delegation["tab-1"]).toBe("observe");
  });

  it("every user action is ledgered as a control line", () => {
    applySupervisorAction({ projectId: "proj", action: "start" }, token());
    applySupervisorAction({ projectId: "proj", action: "charter", text: "ship the billing page; never touch auth" }, token());
    const kinds = readLedger("proj").map((e) => `${e.kind}:${e.verb}`);
    expect(kinds).toEqual(["control:start", "control:charter"]);
    expect(getSupervisorState("proj").charter).toBe("ship the billing page; never touch auth");
  });
});

describe("supervisor ledger — append-only, 0600, beside the state", () => {
  it("appends one JSON line per entry and reads them back newest last", () => {
    appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "t", wakeId: "w", mode: "shadow", decision: "propose", reason: "r1", argsDigest: digestArgs({ a: 1 }), grounds: [] });
    appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "u", wakeId: "w", mode: "shadow", decision: "escalate", reason: "r2", argsDigest: digestArgs({ a: 2 }), grounds: [] });
    const lines = readFileSync(ledgerPath("proj"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(statSync(ledgerPath("proj")).mode & 0o777).toBe(0o600);
    expect(ledgerPath("proj").startsWith(dataDir)).toBe(true);
    expect(readLedger("proj").map((e) => e.reason)).toEqual(["r1", "r2"]);
    expect(readLedger("proj", { tab: "u" }).map((e) => e.reason)).toEqual(["r2"]);
    expect(readLedger("proj", { limit: 1 }).map((e) => e.reason)).toEqual(["r2"]);
  });

  it("digests arguments stably and never stores them raw", () => {
    expect(digestArgs({ b: 2, a: 1 })).toBe(digestArgs({ a: 1, b: 2 }));
    expect(digestArgs({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
    appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "t", wakeId: null, mode: "shadow", decision: "propose", reason: "x", argsDigest: digestArgs({ secret: "s3cr3t" }), grounds: [] });
    expect(readFileSync(ledgerPath("proj"), "utf8")).not.toContain("s3cr3t");
  });

  it("skips a torn line instead of failing the read", () => {
    appendLedgerEntry("proj", { kind: "verb", verb: "answer", tab: "t", wakeId: null, mode: "shadow", decision: "propose", reason: "ok", argsDigest: "0", grounds: [] });
    writeFileSync(ledgerPath("proj"), `${readFileSync(ledgerPath("proj"), "utf8")}{"torn":`, { flag: "w" });
    expect(readLedger("proj").map((e) => e.reason)).toEqual(["ok"]);
    expect(existsSync(ledgerPath("proj"))).toBe(true);
  });
});
