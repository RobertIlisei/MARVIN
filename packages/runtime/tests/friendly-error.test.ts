import { describe, expect, it } from "vitest";

import { friendlyError } from "../src/sdk-runner";

// Pin the upstream-error → actionable-message map. The point of this
// helper is that a user hitting one of these for the first time gets
// a fix path, not a raw API blob. New patterns: add the recogniser to
// `friendlyError`, then add a case here.

describe("friendlyError — Consumer Terms 400", () => {
  it("recognises the literal Anthropic 400 body", () => {
    const raw =
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"We\'ve updated our Consumer Terms and Privacy Policy. ' +
      'You\'ll need to accept them in claude.ai with the email in /status to ' +
      'continue."},"request_id":"req_011CahJ6s7Yxw1QhJVfjVZCP"}';
    const friendly = friendlyError(raw);
    expect(friendly).toMatch(/accept the updated Consumer Terms/i);
    expect(friendly).toMatch(/claude\.ai/);
    expect(friendly).toMatch(/claude \/status/);
  });

  it("matches case-insensitively", () => {
    const friendly = friendlyError("we've UPDATED OUR consumer terms blah");
    expect(friendly).toMatch(/Consumer Terms/);
  });
});

describe("friendlyError — claude binary missing", () => {
  it("recognises spawn ENOENT for claude", () => {
    const friendly = friendlyError("spawn claude ENOENT");
    expect(friendly).toMatch(/Claude Code CLI not found/i);
    expect(friendly).toMatch(/npm install -g @anthropic-ai\/claude-code/);
    expect(friendly).toMatch(/MARVIN_CLAUDE_BIN/);
  });

  it("recognises a generic ENOENT path that mentions claude", () => {
    const friendly = friendlyError(
      "Error: ENOENT: no such file or directory, open '/usr/local/bin/claude'",
    );
    expect(friendly).toMatch(/Claude Code CLI not found/i);
  });
});

describe("friendlyError — auth missing", () => {
  it("recognises 'API key not found'", () => {
    const friendly = friendlyError("API key not found in environment");
    expect(friendly).toMatch(/credentials missing/i);
    expect(friendly).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("recognises 'invalid x-api-key'", () => {
    const friendly = friendlyError("401 invalid x-api-key");
    expect(friendly).toMatch(/credentials missing/i);
  });
});

describe("friendlyError — passthrough", () => {
  it("returns unrecognised errors verbatim", () => {
    const raw = "EHOSTUNREACH: cannot reach api.anthropic.com";
    expect(friendlyError(raw)).toBe(raw);
  });

  it("returns the empty string verbatim (no rewrite for empty input)", () => {
    expect(friendlyError("")).toBe("");
  });
});
