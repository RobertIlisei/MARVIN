import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ADR-0072 — the session picker's list must not parse every transcript.
//
// MARVIN_DATA_DIR is read by `marvinPaths` at call time, so pointing it at a
// temp dir before importing gives a fully isolated fixture tree.

let dataDir: string;
const PROJECT = "test-project";

async function freshModule() {
  // The module caches nothing across imports today, but re-importing keeps
  // this test honest if an in-process cache is ever added.
  return await import("../src/session");
}

function sessionsDir(): string {
  return path.join(dataDir, "sessions", PROJECT);
}

/** Write a transcript with `userTurns` user records interleaved with noise
 *  that must NOT be counted — including cli.events whose payload embeds the
 *  literal text of a user turn. */
function writeTranscript(sessionId: string, userTurns: string[]): string {
  mkdirSync(sessionsDir(), { recursive: true });
  const lines: string[] = [];
  userTurns.forEach((msg, i) => {
    lines.push(JSON.stringify({ type: "turn.user", at: `2026-01-0${i + 1}`, message: msg }));
    lines.push(
      JSON.stringify({
        type: "cli.event",
        at: `2026-01-0${i + 1}`,
        event: { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
      }),
    );
    lines.push(
      JSON.stringify({ type: "turn.completed", at: `2026-01-0${i + 1}`, durationMs: 1 }),
    );
  });
  const p = path.join(sessionsDir(), `${sessionId}.jsonl`);
  writeFileSync(p, `${lines.join("\n")}\n`, "utf-8");
  return p;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-summ-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  process.env.MARVIN_DATA_DIR = undefined;
});

describe("scanSessionSummary", () => {
  it("counts user turns and reads the first message without parsing every line", async () => {
    const { scanSessionSummary } = await freshModule();
    const p = writeTranscript("s1", ["first question", "second question", "third"]);
    const summary = scanSessionSummary(p);
    expect(summary.turnCount).toBe(3);
    expect(summary.firstUserMessage).toBe("first question");
  });

  it("agrees with the parsed count — the property the old implementation had", async () => {
    const { scanSessionSummary, loadSession } = await freshModule();
    const msgs = Array.from({ length: 25 }, (_, i) => `question ${i}`);
    const p = writeTranscript("s2", msgs);

    const parsed = loadSession(PROJECT, "s2")!;
    const parsedCount = parsed.turns.filter((t) => t.type === "turn.user").length;
    expect(scanSessionSummary(p).turnCount).toBe(parsedCount);
  });

  it("truncates the preview to 120 chars, like the route always did", async () => {
    const { scanSessionSummary } = await freshModule();
    const p = writeTranscript("s3", ["x".repeat(500)]);
    expect(scanSessionSummary(p).firstUserMessage).toHaveLength(120);
  });

  it("returns an empty summary for an unreadable file rather than throwing", async () => {
    const { scanSessionSummary } = await freshModule();
    expect(scanSessionSummary(path.join(sessionsDir(), "nope.jsonl"))).toEqual({
      firstUserMessage: null,
      turnCount: 0,
    });
  });

  it("does not count the marker when it appears inside a cli.event payload", async () => {
    const { scanSessionSummary } = await freshModule();
    mkdirSync(sessionsDir(), { recursive: true });
    const p = path.join(sessionsDir(), "s4.jsonl");
    // One real user turn, plus an assistant event QUOTING a transcript record.
    // The quoted copy escapes its quotes, so the raw marker does not appear.
    const lines = [
      JSON.stringify({ type: "turn.user", at: "t", message: "the only real turn" }),
      JSON.stringify({
        type: "cli.event",
        at: "t",
        event: {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: 'here is a record: {"type":"turn.user","message":"quoted"}' },
            ],
          },
        },
      }),
    ];
    writeFileSync(p, `${lines.join("\n")}\n`, "utf-8");
    expect(scanSessionSummary(p).turnCount).toBe(1);
  });
});

describe("listSessionSummaries", () => {
  it("summarises every session, newest first", async () => {
    const { listSessionSummaries } = await freshModule();
    writeTranscript("old", ["older question"]);
    // Distinct mtimes so ordering is deterministic.
    const p2 = writeTranscript("new", ["newer question", "and another"]);
    const now = Date.now();
    const { utimesSync } = await import("node:fs");
    utimesSync(p2, new Date(now), new Date(now + 60_000));

    const out = listSessionSummaries(PROJECT);
    expect(out.map((s) => s.sessionId)).toEqual(["new", "old"]);
    expect(out[0]!.turnCount).toBe(2);
    expect(out[0]!.firstUserMessage).toBe("newer question");
  });

  it("writes a cache and serves the second call from it", async () => {
    const { listSessionSummaries } = await freshModule();
    writeTranscript("s1", ["hello"]);

    const first = listSessionSummaries(PROJECT);
    const cachePath = path.join(sessionsDir(), ".summaries.json");
    expect(existsSync(cachePath)).toBe(true);

    // Corrupt the transcript body but keep mtime+size identical — a cache hit
    // must not re-read it. This is what makes the warm path ~free.
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cached.s1.turnCount).toBe(1);

    const second = listSessionSummaries(PROJECT);
    expect(second).toEqual(first);
  });

  it("recomputes when the transcript grows (append-only sessions)", async () => {
    const { listSessionSummaries } = await freshModule();
    writeTranscript("s1", ["one"]);
    expect(listSessionSummaries(PROJECT)[0]!.turnCount).toBe(1);

    // Append a second turn — size changes, so the cache entry is stale.
    writeTranscript("s1", ["one", "two"]);
    expect(listSessionSummaries(PROJECT)[0]!.turnCount).toBe(2);
  });

  it("drops cache entries for deleted transcripts", async () => {
    const { listSessionSummaries } = await freshModule();
    writeTranscript("keep", ["a"]);
    writeTranscript("drop", ["b"]);
    listSessionSummaries(PROJECT);

    rmSync(path.join(sessionsDir(), "drop.jsonl"));
    const out = listSessionSummaries(PROJECT);
    expect(out.map((s) => s.sessionId)).toEqual(["keep"]);

    const cached = JSON.parse(readFileSync(path.join(sessionsDir(), ".summaries.json"), "utf-8"));
    expect(Object.keys(cached)).toEqual(["keep"]);
  });

  it("returns an empty list for a project with no sessions", async () => {
    const { listSessionSummaries } = await freshModule();
    expect(listSessionSummaries("never-used")).toEqual([]);
  });
});
