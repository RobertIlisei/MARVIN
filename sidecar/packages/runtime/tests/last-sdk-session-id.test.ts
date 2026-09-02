// Resuming a MARVIN session means translating `marvinSessionId` → the SDK's
// own `sessionId`. `turn.completed` carries it, but a turn that was killed
// mid-flight never writes one — so a crash used to cost the whole turn's
// context, silently, on the next message.
//
// Shapes here are taken from the real transcript `a7382d02` recorded when
// MARVIN died to the ADR-0062 constraint loop on 2026-09-01: 67 `cli.event`s
// carrying SDK session `7a83431d…`, no `turn.completed`, and the user's next
// message opening a brand-new SDK session instead of resuming.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lastSdkSessionId } from "../src/session";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-last-sdk-id-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.MARVIN_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Write a transcript and return the marvinSessionId that addresses it. */
function transcript(projectId: string, lines: unknown[]): string {
  const marvinSessionId = `sess-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(dataDir, "sessions", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${marvinSessionId}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    "utf-8",
  );
  return marvinSessionId;
}

const cliEvent = (sessionId: string, subtype = "init") => ({
  type: "cli.event",
  at: "2026-09-01T13:43:51.975Z",
  event: { type: "system", subtype, session_id: sessionId },
});

const completed = (sessionId: string | null) => ({
  type: "turn.completed",
  at: "2026-09-01T13:44:10.000Z",
  durationMs: 1000,
  costUsd: null,
  tokenUsage: null,
  sessionId,
});

describe("lastSdkSessionId", () => {
  it("returns the id from the most recent completed turn", () => {
    const id = transcript("proj-completed", [
      cliEvent("sdk-old"),
      completed("sdk-old"),
      cliEvent("sdk-new"),
      completed("sdk-new"),
    ]);
    expect(lastSdkSessionId("proj-completed", id)).toBe("sdk-new");
  });

  it("recovers the SDK id of a turn that was killed before it completed", () => {
    // The crash shape: one finished turn, then a turn that streamed events
    // and died. Resuming the FINISHED turn would drop everything the killed
    // turn did — an hour of context, in the 2026-09-01 incident.
    const id = transcript("proj-crashed", [
      cliEvent("sdk-finished"),
      completed("sdk-finished"),
      { type: "turn.user", at: "2026-09-01T13:43:50.034Z", message: "hotfix it" },
      cliEvent("sdk-killed"),
      cliEvent("sdk-killed", "assistant"),
    ]);
    expect(lastSdkSessionId("proj-crashed", id)).toBe("sdk-killed");
  });

  it("skips a completed turn whose sessionId is null and keeps scanning", () => {
    const id = transcript("proj-null", [
      cliEvent("sdk-real"),
      completed("sdk-real"),
      completed(null),
    ]);
    expect(lastSdkSessionId("proj-null", id)).toBe("sdk-real");
  });

  it("ignores a cli.event with no usable session_id", () => {
    const id = transcript("proj-nosid", [
      cliEvent("sdk-real"),
      completed("sdk-real"),
      { type: "cli.event", at: "x", event: { type: "system", session_id: "" } },
      { type: "cli.event", at: "x", event: { type: "system" } },
      { type: "cli.event", at: "x", event: { session_id: 42 } },
      { type: "cli.event", at: "x", event: null },
    ]);
    expect(lastSdkSessionId("proj-nosid", id)).toBe("sdk-real");
  });

  it("returns null for an unknown session", () => {
    expect(lastSdkSessionId("proj-missing", "nope")).toBeNull();
  });

  it("survives a malformed line", () => {
    const marvinSessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const dir = path.join(dataDir, "sessions", "proj-malformed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${marvinSessionId}.jsonl`),
      `${JSON.stringify(cliEvent("sdk-real"))}\n{ not json\n\n`,
      "utf-8",
    );
    expect(lastSdkSessionId("proj-malformed", marvinSessionId)).toBe("sdk-real");
  });
});
