import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendSessionTurn } from "../src/session";
import { AUDITOR_DISALLOWED_TOOLS } from "../src/session-auditor";
import {
  buildSupervisorAuditPacket,
  buildSupervisorAuditQueryOptions,
  runSupervisorAudit,
  SUPERVISOR_AUDIT_CLASSES,
  SUPERVISOR_AUDITOR_SYSTEM_PROMPT,
  supervisorAuditCandidates,
} from "../src/supervisor-audit";
import { appendLedgerEntry, readLedger } from "../src/supervisor-ledger";
import { listMessages } from "../src/supervisor-messages";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";
import { type ProjectEvent, subscribeProjectEvents } from "../src/turn-registry";

// ADR-0127 §7 (ADR-0059 amended) — the session auditor reviews the supervisor's
// ledger over a window, set against the transcripts of the tabs it acted on,
// with four new finding classes. The report goes to the USER; nothing reaches
// the supervisor session — the reviewed is not briefed by its reviewer.

let dataDir: string;
let cwd: string;
const prev = process.env.MARVIN_DATA_DIR;
const P = "proj";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-audit-data-"));
  cwd = mkdtempSync(path.join(tmpdir(), "marvin-sup-audit-cwd-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: P, action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, currentSupervisorToken());
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function seed() {
  for (let i = 0; i < 3; i += 1) {
    appendLedgerEntry(P, { kind: "verb", verb: "send", tab: "tab-1", wakeId: `w${i}`, mode: "autonomous", decision: "act", reason: "nudge", reasonCode: "grounded", argsDigest: "same", grounds: [{ kind: "plan", ref: "2", provenance: "weak" }] });
  }
  appendLedgerEntry(P, { kind: "verb", verb: "confirm", tab: "tab-1", wakeId: null, mode: "autonomous", decision: "act", reason: "allowed", grounds: [] });
  appendLedgerEntry(P, { kind: "verb", verb: "answer", tab: "tab-1", wakeId: "w9", mode: "shadow", decision: "escalate", reason: "names push", reasonCode: "human-only", heuristic: "push" });
  appendSessionTurn(P, "tab-1", { type: "turn.user", at: new Date().toISOString(), message: "[Message from the MARVIN supervisor] keep going", author: "supervisor" });
}

describe("the packet and the deterministic candidates", () => {
  it("covers the window's ledger lines and the transcripts of the tabs acted on", () => {
    seed();
    const packet = buildSupervisorAuditPacket(P, {});
    expect(packet.lines.length).toBe(readLedger(P).length);
    expect(packet.tabs.map((t) => t.sessionId)).toEqual(["tab-1"]);
    expect(packet.tabs[0]?.supervisorMessages).toEqual(["[Message from the MARVIN supervisor] keep going"]);
  });

  it("raises candidates in each of the four classes", () => {
    seed();
    const classes = new Set(supervisorAuditCandidates(buildSupervisorAuditPacket(P, {})).map((c) => c.class));
    expect([...classes].sort()).toEqual([...SUPERVISOR_AUDIT_CLASSES].sort());
  });
});

describe("the run — read-only, to the user, never to the supervisor", () => {
  it("produces a report with the four finding classes, persisted 0600 under the data dir", async () => {
    seed();
    const report = "## Verdict\nMostly sound.\n\n## Findings\n\n### Three nudges at one step\n- class: loop\n- severity: warn\n- claim: ledger seq 0–2\n- evidence: same digest\n- suggest: lower the nudge cap\n";
    const runQuery = vi.fn(async () => ({ ok: true as const, text: report, costUsd: 0.12 }));
    const out = await runSupervisorAudit({ projectId: P, cwd, runQuery });
    expect(out.ok).toBe(true);
    expect(out.findings?.[0]).toMatchObject({ class: "loop", severity: "warn" });
    expect(out.path && existsSync(out.path)).toBe(true);
    expect(out.path?.startsWith(dataDir)).toBe(true);
    expect(statSync(out.path as string).mode & 0o777).toBe(0o600);
    expect(readFileSync(out.path as string, "utf8")).toContain("Three nudges at one step");
    const prompt = (runQuery.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    for (const c of SUPERVISOR_AUDIT_CLASSES) expect(SUPERVISOR_AUDITOR_SYSTEM_PROMPT).toContain(c);
    expect(prompt).toContain("<untrusted-");
  });

  it("nothing reaches the supervisor: no ledger line, no message, no wake, no state change, and no supervisor tools", async () => {
    seed();
    const before = { ledger: readLedger(P).length, messages: listMessages(P).length, revision: getSupervisorState(P).revision };
    const events: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => events.push(e));
    try {
      await runSupervisorAudit({ projectId: P, cwd, runQuery: async () => ({ ok: true, text: "## Verdict\nClean.\n" }) });
    } finally {
      off();
    }
    expect(readLedger(P).length).toBe(before.ledger);
    expect(listMessages(P).length).toBe(before.messages);
    expect(getSupervisorState(P).revision).toBe(before.revision);
    expect(events.filter((e) => e.event.startsWith("supervisor.") || e.event === "turn.registered")).toEqual([]);

    const opts = buildSupervisorAuditQueryOptions(cwd, undefined) as Record<string, unknown>;
    expect(Object.keys(opts.mcpServers as Record<string, unknown>)).toEqual(["marvin-graph"]);
    expect(opts.disallowedTools).toEqual([...AUDITOR_DISALLOWED_TOOLS]);
    expect(opts).not.toHaveProperty("resume");
    expect(opts.systemPrompt).toBe(SUPERVISOR_AUDITOR_SYSTEM_PROMPT);
  });

  it("an empty window is reported as nothing to audit, without a model call", async () => {
    const runQuery = vi.fn();
    const out = await runSupervisorAudit({ projectId: "empty", cwd, runQuery: runQuery as never });
    expect(out.ok).toBe(false);
    expect(runQuery).not.toHaveBeenCalled();
  });
});
