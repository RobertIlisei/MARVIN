import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addNotice } from "@marvin/runtime/notices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTurnSystemPrompt } from "@/lib/turn-orchestrator";

// ADR-0131 / ADR-0118 — a notice is per-turn text in the reminder suffix; the
// system prompt (one per session, replayed by the SDK) must not move.
let workDir: string;
let dataDir: string;
const prev = process.env.MARVIN_DATA_DIR;
beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-notices-sp-"));
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-notices-sp-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  mkdirSync(path.join(workDir, ".marvin"), { recursive: true });
  writeFileSync(path.join(workDir, "CLAUDE.md"), "# project\n");
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(workDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("buildTurnSystemPrompt", () => {
  it("is byte-identical with and without a live notice", async () => {
    const before = await buildTurnSystemPrompt({ workDir, personality: "neutral" });
    expect(addNotice(workDir, { text: "the test machine moved", author: "user" }).ok).toBe(true);
    const after = await buildTurnSystemPrompt({ workDir, personality: "neutral" });
    expect(after).toBe(before);
    expect(after).not.toContain("the test machine moved");
  });
});
