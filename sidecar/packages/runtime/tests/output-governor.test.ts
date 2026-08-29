import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  GOVERN_HEAD_CHARS,
  GOVERN_MAX_CHARS,
  GOVERN_TAIL_CHARS,
  governText,
  makeOutputGovernorPostToolUse,
} from "../src/output-governor";

/**
 * The governor exists because a 15.7K-char Spring log entered a real
 * transcript whole (2026-08-29). These pin the contract: small output is
 * untouched, big output keeps its first and last lines and says exactly what
 * was cut, and the full text is on disk where the marker says it is.
 */

function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`).join("\n");
}

describe("governText", () => {
  it("passes output at or under the threshold through unchanged", () => {
    const text = "x".repeat(GOVERN_MAX_CHARS);
    const r = governText(text, "/tmp/whatever");
    expect(r.elided).toBe(false);
    expect(r.text).toBe(text);
  });

  it("keeps the head and the tail, cut on line boundaries, and names the cut", () => {
    const text = lines(2000);
    const r = governText(text, "/data/out.txt");
    expect(r.elided).toBe(true);
    expect(r.text.startsWith("line-0\n")).toBe(true);
    expect(r.text.endsWith("line-1999")).toBe(true);
    // No half line on either side of the marker.
    const [head, tail] = r.text.split(/\n\n\[MARVIN output governor:[^\]]*\]\n\n/);
    expect(head?.split("\n").every((l) => /^line-\d+$/.test(l))).toBe(true);
    expect(tail?.split("\n").every((l) => /^line-\d+$/.test(l))).toBe(true);
    expect(r.text).toContain(`${r.elidedLines} lines (${r.elidedChars} chars) elided`);
    expect(r.text).toContain("/data/out.txt");
    // The whole point: bounded, regardless of input size.
    expect(r.text.length).toBeLessThan(GOVERN_HEAD_CHARS + GOVERN_TAIL_CHARS + 400);
  });

  it("says so when the full output could not be saved", () => {
    const r = governText(lines(2000), null);
    expect(r.text).toContain("could not be saved");
  });
});

describe("makeOutputGovernorPostToolUse", () => {
  let dataDir: string;
  let prevDataDir: string | undefined;
  let prevMode: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "marvin-governor-"));
    prevDataDir = process.env.MARVIN_DATA_DIR;
    prevMode = process.env.MARVIN_OUTPUT_GOVERNOR;
    process.env.MARVIN_DATA_DIR = dataDir;
    delete process.env.MARVIN_OUTPUT_GOVERNOR;
  });
  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.MARVIN_DATA_DIR;
    else process.env.MARVIN_DATA_DIR = prevDataDir;
    if (prevMode === undefined) delete process.env.MARVIN_OUTPUT_GOVERNOR;
    else process.env.MARVIN_OUTPUT_GOVERNOR = prevMode;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const hook = () => makeOutputGovernorPostToolUse({ marvinSessionId: "sess", turnId: "t1" });
  const bash = (stdout: string, stderr = "") => ({
    hook_event_name: "PostToolUse" as const,
    tool_name: "Bash",
    tool_input: { command: "make smoke" },
    tool_response: { stdout, stderr, interrupted: false, isImage: false },
    tool_use_id: "toolu_1",
    session_id: "s",
    transcript_path: "",
    cwd: "",
  });

  it("leaves small Bash output alone", async () => {
    const out = await hook()(bash("BUILD SUCCESS") as never, "toolu_1", { signal: new AbortController().signal });
    expect(out).toEqual({});
  });

  it("governs big Bash stdout, persists the full text, and keeps the other fields", async () => {
    const big = lines(3000, "log");
    const out = (await hook()(bash(big, "warn") as never, "toolu_1", { signal: new AbortController().signal })) as {
      hookSpecificOutput?: { updatedToolOutput?: Record<string, unknown> };
    };
    const updated = out.hookSpecificOutput?.updatedToolOutput;
    expect(updated).toBeDefined();
    expect(updated?.interrupted).toBe(false); // untouched sibling field
    expect(updated?.stderr).toBe("warn"); // under threshold → unchanged
    const stdout = String(updated?.stdout);
    expect(stdout).toContain("MARVIN output governor");
    expect(stdout.length).toBeLessThan(big.length / 4);
    const saved = join(dataDir, "tool-output", "sess", "toolu_1.txt");
    expect(existsSync(saved)).toBe(true);
    expect(readFileSync(saved, "utf-8")).toContain("log-2999");
    expect(stdout).toContain(saved);
  });

  it("ignores every tool but Bash", async () => {
    const evt = { ...bash(lines(3000)), tool_name: "Read" };
    const out = await hook()(evt as never, "toolu_1", { signal: new AbortController().signal });
    expect(out).toEqual({});
  });

  it("can be switched off", async () => {
    process.env.MARVIN_OUTPUT_GOVERNOR = "off";
    const out = await hook()(bash(lines(3000)) as never, "toolu_1", { signal: new AbortController().signal });
    expect(out).toEqual({});
  });
});
