import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-surrogates-"));

import { surrogateSafeHead, surrogateSafeTail } from "../src/background-jobs";
import { appendSessionTurn, loadSession, scrubLoneSurrogates } from "../src/session";
import { marvinPaths } from "../src/paths";

// 2026-09-03: a background job's excerpt was cut through U+1FA4F, the lone
// low half went into the transcript as `\ude4f`, and the native app refused
// to hydrate the whole session — "we don't know where marvin was".
const LONE = /(?<![\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])/;

describe("background-job window never keeps half an emoji", () => {
  const emoji = "\u{1FA4F}"; // two UTF-16 units
  it("head cut on the pair boundary drops the high half", () => {
    const s = "x".repeat(1023) + emoji.repeat(10);
    const head = surrogateSafeHead(s, 1024);
    expect(head).toBe("x".repeat(1023));
    expect(head).not.toMatch(LONE);
    // A cut that does not split a pair is untouched.
    expect(surrogateSafeHead(s, 1025)).toBe("x".repeat(1023) + emoji);
  });
  it("tail cut on the pair boundary drops the low half", () => {
    const s = emoji.repeat(10) + "y".repeat(100);
    const tail = surrogateSafeTail(s, 101);
    expect(tail).toBe("y".repeat(100));
    expect(tail).not.toMatch(LONE);
    expect(surrogateSafeTail(s, 102)).toBe(emoji + "y".repeat(100));
  });
});

describe("transcript boundary scrubs lone surrogates", () => {
  const projectId = "p-surrogates";
  const sessionId = "s-1";
  afterAll(() => rmSync(process.env.MARVIN_DATA_DIR!, { recursive: true, force: true }));

  it("scrubLoneSurrogates replaces escaped lone halves and leaves pairs and literal text alone", () => {
    expect(scrubLoneSurrogates('{"m":"a\\ude4fb"}')).toBe('{"m":"a\\ufffdb"}');
    expect(scrubLoneSurrogates('{"m":"a\\ud83eb"}')).toBe('{"m":"a\\ufffdb"}');
    // A real pair is written by JSON.stringify as the literal character.
    const pair = JSON.stringify({ m: "\u{1FA4F}" });
    expect(scrubLoneSurrogates(pair)).toBe(pair);
    // Someone's CONTENT containing the six characters `\ude4f` (an escaped
    // backslash in JSON) is text, not a surrogate.
    const literal = JSON.stringify({ m: "\\ude4f" });
    expect(scrubLoneSurrogates(literal)).toBe(literal);
  });

  it("appendSessionTurn writes U+FFFD in place of a lone surrogate, and the line decodes", () => {
    appendSessionTurn(projectId, sessionId, {
      type: "turn.user",
      at: new Date().toISOString(),
      message: "cut here \ude4f and on",
    });
    const raw = readFileSync(marvinPaths.sessionFile(projectId, sessionId), "utf-8");
    expect(raw).not.toContain("\\ude4f");
    expect(raw).toContain("\\ufffd");
    const parsed = JSON.parse(raw.trim()) as { message: string };
    expect(parsed.message).not.toMatch(LONE);
  });

  it("loadSession heals a transcript that already carries one", () => {
    const path = marvinPaths.sessionFile("p-legacy", "s-legacy");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"type":"turn.user","at":"2026-09-03T00:00:00Z","message":"half \\ude4f here"}\n');
    const rec = loadSession("p-legacy", "s-legacy");
    const msg = (rec?.turns[0] as { message?: string } | undefined)?.message ?? "";
    expect(msg).toContain("half");
    expect(msg).not.toMatch(LONE);
    expect(JSON.stringify(rec)).not.toContain("\\ude4f");
  });
});
