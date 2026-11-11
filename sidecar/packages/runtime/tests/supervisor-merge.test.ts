import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { actionsFor, addInboxItem, buildRawAct, getInboxItem } from "../src/supervisor-inbox";
import { actOnInboxItem, type InboxPerform } from "../src/supervisor-inbox-actions";
import { defaultInboxPerform } from "../src/supervisor-inbox-perform";
import { supervisorDir } from "../src/supervisor-ledger";
import {
  activeAuthorisation,
  approveMerge,
  checkMergeProposal,
  GATE_DEFAULT_TIMEOUT_MS,
  GATE_MAX_TIMEOUT_MS,
  holdBranch,
  insideWindow,
  MERGE_MAX_EXPIRY_MS,
  type MergeProposal,
  mergePath,
  mergeView,
  noteExpired,
  readMerge,
  releaseOwnHold,
  revokeMerge,
} from "../src/supervisor-merge";
import { bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "../src/supervisor-state";

// ADR-0134 invariants 1 and 2 — the authorisation is created only by the user's
// click on a card that shows the target and the gate in full; it lives in the
// supervisor dir; it expires within 14 days; it is revoked in one click; a
// changed gate or target is a new approval.

let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
const token = () => currentSupervisorToken() as string;
const proposal = (extra: Partial<MergeProposal> = {}): MergeProposal => ({
  target: "integration",
  gate: "pnpm test:full",
  timeoutMs: GATE_DEFAULT_TIMEOUT_MS,
  holds: [],
  validForHours: 24,
  timeZone: "Europe/Bucharest",
  ...extra,
});
const performer = () => defaultInboxPerform("proj", dataDir, token()) as InboxPerform;
const mergeCard = (p: MergeProposal) =>
  addInboxItem("proj", {
    sessionId: null,
    kind: "queue",
    escalatedBecause: { code: "human-only", label: "x" },
    rawAct: buildRawAct("propose_merge", { ...p }),
    queue: { kind: "merge", proposal: p, previous: null },
    grounds: [],
    act: { type: "queue", what: "merge" },
    modeAtCreation: "shadow",
  });

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-merge-"));
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

describe("with no authorisation, nothing is authorised (invariant 1)", () => {
  it("reads as none: no active authorisation, an empty view", () => {
    expect(activeAuthorisation("proj")).toBeNull();
    expect(mergeView("proj").authorisation).toBeNull();
    expect(existsSync(mergePath("proj"))).toBe(false);
  });
});

describe("the authorisation is the user's click, stored in the supervisor dir (invariant 2)", () => {
  it("a card carries the target and the gate command IN FULL, and requires the raw act to be expanded", () => {
    const gate = `pnpm test:full # ${"x".repeat(400)}`;
    const item = mergeCard(proposal({ gate }));
    expect(item.rawAct?.summary).toContain("integration");
    expect(item.rawAct?.summary).toContain(gate);
    expect(item.rawAct?.summary).toContain("no push, tag, merge request or CI");
    const consent = actionsFor(item).find((a) => a.id === "approve");
    expect(consent).toMatchObject({ role: "consent", requiresExpanded: true });
  });

  it("a card that is only raised authorises nothing; the user's click creates it, in the supervisor dir and never the project", async () => {
    const item = mergeCard(proposal());
    expect(activeAuthorisation("proj")).toBeNull();
    const r = await actOnInboxItem("proj", { id: item.id, actionId: "approve" }, performer());
    expect(r.ok).toBe(true);
    const a = activeAuthorisation("proj");
    expect(a).toMatchObject({ target: "integration", gate: "pnpm test:full", approvedBy: "user", timeZone: "Europe/Bucharest" });
    expect(mergePath("proj")).toBe(path.join(supervisorDir("proj"), "merge.json"));
    expect(mergePath("proj").startsWith(dataDir)).toBe(true);
    expect(getInboxItem("proj", item.id)?.state).toBe("resolved");
  });

  it("the click approves exactly what the card showed: the target and gate cannot be edited at the click", async () => {
    const item = mergeCard(proposal());
    await actOnInboxItem("proj", { id: item.id, actionId: "approve", edits: { target: "main", gate: "rm -rf ~" } }, performer());
    expect(activeAuthorisation("proj")).toMatchObject({ target: "integration", gate: "pnpm test:full" });
  });

  it("a changed gate command or target is a NEW approval: the old one stands until the user clicks the new card", async () => {
    await actOnInboxItem("proj", { id: mergeCard(proposal()).id, actionId: "approve" }, performer());
    const next = mergeCard(proposal({ gate: "pnpm test:other" }));
    expect(activeAuthorisation("proj")?.gate).toBe("pnpm test:full");
    await actOnInboxItem("proj", { id: next.id, actionId: "approve" }, performer());
    expect(activeAuthorisation("proj")?.gate).toBe("pnpm test:other");
  });

  it("drops a hand-written or model-written file that is not exactly what a click writes", () => {
    mkdirSync(supervisorDir("proj"), { recursive: true });
    const now = Date.now();
    const good = {
      target: "integration",
      gate: "true",
      timeoutMs: GATE_DEFAULT_TIMEOUT_MS,
      holds: [],
      approvedAt: new Date(now).toISOString(),
      approvedBy: "user",
      expiresAt: new Date(now + 3600_000).toISOString(),
      timeZone: "UTC",
    };
    const write = (a: Record<string, unknown>) => writeFileSync(mergePath("proj"), JSON.stringify({ version: 1, authorisation: a }));
    write(good);
    expect(readMerge("proj").authorisation).not.toBeNull();
    const bad: Array<Record<string, unknown>> = [
      { ...good, approvedBy: "supervisor" },
      { ...good, approvedBy: undefined },
      { ...good, approvedAt: "yesterday-ish" },
      { ...good, expiresAt: undefined },
      { ...good, expiresAt: new Date(now + MERGE_MAX_EXPIRY_MS + 3600_000).toISOString() },
      { ...good, expiresAt: new Date(now - 10).toISOString() },
      { ...good, gate: "" },
      { ...good, gate: "x".repeat(1001) },
      { ...good, target: "--upload-pack=evil" },
      { ...good, target: "a..b" },
      { ...good, timeoutMs: 1 },
      { ...good, timeoutMs: GATE_MAX_TIMEOUT_MS + 1 },
      { ...good, holds: [{ pathGlob: "a/**", window: { from: "9am", to: "10pm" } }] },
    ];
    for (const b of bad) {
      write(b);
      expect(readMerge("proj").authorisation).toBeNull();
    }
    writeFileSync(mergePath("proj"), "{not json");
    expect(readMerge("proj").authorisation).toBeNull();
  });

  it("an expiry is required, at most 14 days from the approval", () => {
    expect(checkMergeProposal({ target: "t", gate: "true", validForHours: 14 * 24 }).ok).toBe(true);
    for (const bad of [14 * 24 + 1, 0, -1, 1.5, "7", null]) expect(checkMergeProposal({ target: "t", gate: "true", validForHours: bad }).ok).toBe(false);
    const r = approveMerge("proj", proposal({ validForHours: 14 * 24 + 1 }));
    expect(r.ok).toBe(false);
    expect(activeAuthorisation("proj")).toBeNull();
    const ok = approveMerge("proj", proposal({ validForHours: 2 }), new Date(1_000_000));
    expect(ok).toMatchObject({ ok: true, expiresAt: new Date(1_000_000 + 2 * 3600_000).toISOString() });
  });

  it("past its expiry it is no authorisation, and the end is recorded once", () => {
    approveMerge("proj", proposal({ validForHours: 1 }), new Date(0));
    expect(activeAuthorisation("proj", 3_599_000)).not.toBeNull();
    expect(activeAuthorisation("proj", 3_600_001)).toBeNull();
    expect(noteExpired("proj", 3_600_001)).toBe(true);
    expect(readMerge("proj").ended).toMatchObject({ why: "expired", target: "integration" });
    expect(noteExpired("proj", 3_700_000)).toBe(false);
  });

  it("is revoked in one call; the workspace says how it ended", () => {
    approveMerge("proj", proposal());
    expect(revokeMerge("proj")).toBe(true);
    expect(activeAuthorisation("proj")).toBeNull();
    expect(mergeView("proj").ended).toMatchObject({ why: "revoked", target: "integration" });
    expect(revokeMerge("proj")).toBe(false);
  });

  it("is shown in full: target, the gate text, the holds, the zone and the expiry", () => {
    approveMerge("proj", proposal({ holds: [{ pathGlob: "scripts/gate/**", window: { from: "21:00", to: "07:00" } }] }));
    const v = mergeView("proj");
    expect(v.authorisation).toMatchObject({ target: "integration", gate: "pnpm test:full", timeZone: "Europe/Bucharest", holds: [{ pathGlob: "scripts/gate/**" }], expired: false });
    expect(v.authorisation?.timeoutSeconds).toBe(GATE_DEFAULT_TIMEOUT_MS / 1000);
  });

  it("refuses a proposal that is not a local integration branch, an option-shaped name, a secret-shaped gate or a wild timeout", () => {
    for (const p of [{ target: "marvin/tab/x", gate: "true" }, { target: "-x", gate: "true" }, { target: "t", gate: "curl -H 'x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' u" }, { target: "t", gate: "true", timeoutMs: 5 }]) {
      expect(checkMergeProposal(p).ok).toBe(false);
    }
  });
});

describe("a supervisor hold narrows only (invariant 10, the store half)", () => {
  it("holds a branch and releases only its own hold; a hold needs an authorisation to sit under", () => {
    expect(holdBranch("proj", "marvin/tab/a", "wait").ok).toBe(false);
    approveMerge("proj", proposal());
    expect(holdBranch("proj", "marvin/tab/a", "wait for the schema").ok).toBe(true);
    expect(holdBranch("proj", "marvin/tab/a", "again").ok).toBe(false);
    expect(readMerge("proj").holds).toMatchObject([{ branch: "marvin/tab/a", reason: "wait for the schema", by: "supervisor" }]);
    expect(releaseOwnHold("proj", "marvin/tab/other").ok).toBe(false);
    expect(releaseOwnHold("proj", "marvin/tab/a").ok).toBe(true);
    expect(readMerge("proj").holds).toEqual([]);
  });

  it("a hold line the supervisor did not place (by !== supervisor) is dropped at the read boundary", () => {
    approveMerge("proj", proposal());
    const raw = JSON.parse(readFileSync(mergePath("proj"), "utf8"));
    raw.holds = [{ branch: "marvin/tab/a", reason: "r", at: new Date().toISOString(), by: "user" }];
    writeFileSync(mergePath("proj"), JSON.stringify(raw));
    expect(readMerge("proj").holds).toEqual([]);
  });
});

describe("hold windows are local time and wrap midnight", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 11, h, m);
  it("a same-day window includes from, excludes to", () => {
    const w = { from: "09:00", to: "17:00" };
    expect(insideWindow(w, at(9))).toBe(true);
    expect(insideWindow(w, at(16, 59))).toBe(true);
    expect(insideWindow(w, at(17))).toBe(false);
    expect(insideWindow(w, at(3))).toBe(false);
  });
  it("an evening window wraps midnight", () => {
    const w = { from: "21:00", to: "07:00" };
    expect(insideWindow(w, at(23))).toBe(true);
    expect(insideWindow(w, at(6, 59))).toBe(true);
    expect(insideWindow(w, at(7))).toBe(false);
    expect(insideWindow(w, at(14))).toBe(false);
  });
});
