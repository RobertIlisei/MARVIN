import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  drainPending,
  enqueuePending,
  listPending,
  MAX_PENDING,
  pendingPath,
  renderPendingPrompt,
  STALE_AFTER_MS,
} from "../src/pending-input";

// ADR-0069. The failure: a user message sent while a machine-initiated turn was
// running got `409 turn-in-progress` and was DISCARDED. Verified against the
// real transcript — 150 turn.user records, none of them the message the user
// actually sent. The queue's whole job is that this becomes impossible.

let dir: string;
const P = "proj";
const S = "sess";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marvin-pending-"));
  process.env.MARVIN_DATA_DIR = dir;
});
afterEach(async () => {
  delete process.env.MARVIN_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("enqueue / drain", () => {
  it("accepts a message and persists it TO DISK", () => {
    // In-memory would still lose everything on the restarts this app takes.
    const r = enqueuePending(P, S, "Update graphify");
    expect(r.ok).toBe(true);
    expect(existsSync(pendingPath(P, S))).toBe(true);
    expect(listPending(P, S).map((m) => m.text)).toEqual(["Update graphify"]);
  });

  it("survives a process restart — the point of using disk", () => {
    enqueuePending(P, S, "still here");
    // A fresh read with no in-memory state at all:
    expect(listPending(P, S).map((m) => m.text)).toEqual(["still here"]);
  });

  it("drains everything and leaves the queue empty", () => {
    enqueuePending(P, S, "one");
    enqueuePending(P, S, "two");
    expect(drainPending(P, S).map((m) => m.text)).toEqual(["one", "two"]);
    expect(listPending(P, S)).toEqual([]);
  });

  it("draining an empty or absent queue is harmless", () => {
    expect(drainPending(P, S)).toEqual([]);
    expect(drainPending("nope", "nothing")).toEqual([]);
  });

  it("rejects empty text but never throws", () => {
    expect(enqueuePending(P, S, "   ").ok).toBe(false);
    expect(listPending(P, S)).toEqual([]);
  });

  it("rejects identities that could escape the sessions directory", () => {
    expect(enqueuePending("../etc", S, "x").ok).toBe(false);
    expect(enqueuePending(P, "../../x", "x").ok).toBe(false);
  });

  it("a corrupt queue file does not wedge the session", () => {
    enqueuePending(P, S, "first");
    writeFileSync(pendingPath(P, S), "{ truncated", "utf-8");
    // Reads recover to empty, and the next send still works.
    expect(listPending(P, S)).toEqual([]);
    expect(enqueuePending(P, S, "after corruption").ok).toBe(true);
    expect(listPending(P, S).map((m) => m.text)).toEqual(["after corruption"]);
  });

  it("caps the queue by dropping the OLDEST, keeping newest intent", () => {
    for (let i = 0; i < MAX_PENDING + 3; i += 1) enqueuePending(P, S, `msg ${i}`);
    const texts = listPending(P, S).map((m) => m.text);
    expect(texts).toHaveLength(MAX_PENDING);
    expect(texts.at(-1)).toBe(`msg ${MAX_PENDING + 2}`); // newest kept
    expect(texts).not.toContain("msg 0"); // oldest dropped
  });
});

describe("renderPendingPrompt — coalescing and staleness", () => {
  const now = 1_000_000_000_000;

  it("passes a fresh single message through verbatim", () => {
    // No decoration: the common case must not put words in the user's mouth.
    enqueuePending(P, S, "Update graphify", now);
    const out = renderPendingPrompt(drainPending(P, S), now + 5_000);
    expect(out).toBe("Update graphify");
  });

  it("flags a single STALE message instead of silently executing it", () => {
    // Turns here routinely run 5+ minutes; queued intent can be moot.
    enqueuePending(P, S, "park it as a backlog item", now);
    const out = renderPendingPrompt(drainPending(P, S), now + STALE_AFTER_MS + 60_000)!;
    expect(out).toContain("park it as a backlog item");
    expect(out).toMatch(/queued \d+ minutes? ago/);
    expect(out).toContain("still what's needed");
  });

  it("coalesces several messages into ONE prompt, oldest first", () => {
    // Three queued messages must not become three turns acting on partial intent.
    enqueuePending(P, S, "first", now);
    enqueuePending(P, S, "second", now + 1000);
    enqueuePending(P, S, "third", now + 2000);
    const out = renderPendingPrompt(drainPending(P, S), now + 3000)!;
    expect(out).toContain("3 messages queued");
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("third"));
    expect(out).toContain("the later wins");
  });

  it("returns null for nothing queued", () => {
    expect(renderPendingPrompt([])).toBeNull();
  });

  it("never rewrites the user's words", () => {
    const odd = "run `make e2e` — and DON'T touch main";
    enqueuePending(P, S, odd, now);
    expect(renderPendingPrompt(drainPending(P, S), now + 1000)).toBe(odd);
  });
});
