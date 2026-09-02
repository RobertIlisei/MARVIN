// The shared-tree gate as the SDK sees it: `makeAutoModeLogger` is MARVIN's
// DEFAULT permission callback, and its contract is "never blocks on UI". This
// pins the one narrow exception — a HEAD-moving command while a second session
// is live in the same checkout — and, just as importantly, pins that the gate
// stays invisible in every other case. A guard that fired on single-session
// turns would be turned off within a day.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeAutoModeLogger } from "../src/sdk-runner";
import { endLiveTurn, registerLiveTurn } from "../src/turn-registry";

let cwd: string;
const opened: Array<{ toolUseId: string; reason: string }> = [];
const started: Array<{ marvinSessionId: string; turnId: string }> = [];

/** The SDK's `canUseTool` third argument. */
const meta = (toolUseID: string) => ({ toolUseID }) as never;

/**
 * `CanUseTool` is typed as possibly returning null (a callback that declines to
 * decide). MARVIN's callbacks always decide, so narrow here rather than
 * littering every assertion with `?.` — a null would itself be a failure.
 */
function decided<T>(result: T | null | undefined): T {
  expect(result).toBeTruthy();
  return result as T;
}

function liveTurn(projectId: string, marvinSessionId: string, turnId: string) {
  const turn = registerLiveTurn({ turnId, marvinSessionId, projectId });
  started.push({ marvinSessionId, turnId });
  return turn;
}

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "marvin-shared-tree-"));
  opened.length = 0;
});

afterEach(() => {
  // Turns are process-global; leaving one live would leak into the next test.
  for (const { marvinSessionId } of started.splice(0)) {
    const t = registerLiveTurn({
      turnId: `cleanup-${marvinSessionId}`,
      marvinSessionId,
      projectId: "cleanup",
    });
    endLiveTurn(t, { event: "turn.completed", data: {} });
  }
  rmSync(cwd, { recursive: true, force: true });
});

/** An auto-mode callback for `sessionA`, with a UI attached. */
function gateForSessionA(projectId: string) {
  return makeAutoModeLogger({
    cwd,
    turnId: "turn-A",
    checkpoint: { projectId, marvinSessionId: "session-A" },
    onConfirmRequest: (req) => {
      opened.push({ toolUseId: req.toolUseId, reason: req.reason ?? "" });
    },
  });
}

describe("shared-tree gate — a second session in the same checkout", () => {
  it("stays out of the way when this session is the only one live", async () => {
    const projectId = "proj-solo";
    liveTurn(projectId, "session-A", "turn-A");

    const gate = gateForSessionA(projectId);
    const result = decided(await gate("Bash", { command: "git checkout main" }, meta("t1")));

    expect(result.behavior).toBe("allow");
    expect(opened).toHaveLength(0);
  });

  it("raises a confirm naming the other session for a HEAD-moving command", async () => {
    const projectId = "proj-shared";
    liveTurn(projectId, "session-A", "turn-A");
    liveTurn(projectId, "session-Bcafebabe", "turn-B");

    const gate = gateForSessionA(projectId);
    // Deliberately not awaited: the gate blocks until /api/confirm answers.
    void gate("Bash", { command: "git checkout dep/openapi-fetch" }, meta("t2"));
    await new Promise((r) => setImmediate(r));

    expect(opened).toHaveLength(1);
    expect(opened[0]?.reason).toContain("git checkout");
    expect(opened[0]?.reason).toContain("moves HEAD");
    // The other session is named — the whole point is knowing WHO you'd hit.
    expect(opened[0]?.reason).toContain("session-");
  });

  it("ignores a read-only git command even with a second session live", async () => {
    const projectId = "proj-readonly";
    liveTurn(projectId, "session-A", "turn-A");
    liveTurn(projectId, "session-B", "turn-B");

    const gate = gateForSessionA(projectId);
    const result = decided(await gate("Bash", { command: "git status --porcelain" }, meta("t3")));

    expect(result.behavior).toBe("allow");
    expect(opened).toHaveLength(0);
  });

  it("ignores a live turn in a DIFFERENT project — different tree, no conflict", async () => {
    liveTurn("proj-one", "session-A", "turn-A");
    liveTurn("proj-two", "session-B", "turn-B");

    const gate = gateForSessionA("proj-one");
    const result = decided(await gate("Bash", { command: "git rebase main" }, meta("t4")));

    expect(result.behavior).toBe("allow");
    expect(opened).toHaveLength(0);
  });

  it("stops treating a finished turn as a co-tenant", async () => {
    const projectId = "proj-ended";
    liveTurn(projectId, "session-A", "turn-A");
    const other = liveTurn(projectId, "session-B", "turn-B");
    // `endLiveTurn` keeps the record for a 60 s reconnect grace period, so the
    // gate has to read `ended` rather than mere presence in the map.
    endLiveTurn(other, { event: "turn.completed", data: {} });

    const gate = gateForSessionA(projectId);
    const result = decided(await gate("Bash", { command: "git checkout main" }, meta("t5")));

    expect(result.behavior).toBe("allow");
    expect(opened).toHaveLength(0);
  });

  it("denies rather than runs unattended when no UI can answer", async () => {
    const projectId = "proj-headless";
    liveTurn(projectId, "session-A", "turn-A");
    liveTurn(projectId, "session-B", "turn-B");

    // A wakeup / background-job turn: no onConfirmRequest wired.
    const gate = makeAutoModeLogger({
      cwd,
      turnId: "turn-A",
      checkpoint: { projectId, marvinSessionId: "session-A" },
    });
    const result = decided(await gate("Bash", { command: "git checkout main" }, meta("t6")));

    expect(result.behavior).toBe("deny");
    expect("message" in result && result.message).toContain("worktree");
  });

  it("does not fire for a turn with no session identity to collide with", async () => {
    const projectId = "proj-nosession";
    liveTurn(projectId, "session-B", "turn-B");

    // No `checkpoint` — nothing to compare against, so no conflict is knowable.
    const gate = makeAutoModeLogger({ cwd, turnId: "turn-A" });
    const result = decided(await gate("Bash", { command: "git checkout main" }, meta("t7")));

    expect(result.behavior).toBe("allow");
  });
});
