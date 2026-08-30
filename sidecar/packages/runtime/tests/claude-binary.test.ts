import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { claudeCliVersion } from "../src/claude-cli";

// ADR-0087 — MARVIN resolved the FIRST claude on a fixed path list, which
// put /opt/homebrew/bin ahead of everything. On a machine with both, it ran
// 2.1.92 while the user's shell had 2.1.251 — 159 versions behind, silently.
// The visible symptom was the plan-usage block staying blank: only the newer
// CLI reports `unifiedWindows` on rate-limit events.

function fakeClaude(dir: string, output: string, exitCode = 0): string {
  const p = join(dir, "claude");
  writeFileSync(p, `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("claudeCliVersion", () => {
  it("parses the real --version output shape", () => {
    const d = mkdtempSync(join(tmpdir(), "cbin-"));
    expect(claudeCliVersion(fakeClaude(d, "2.1.251 (Claude Code)"))).toEqual([2, 1, 251]);
  });

  it("parses a version with surrounding noise", () => {
    const d = mkdtempSync(join(tmpdir(), "cbin-"));
    expect(claudeCliVersion(fakeClaude(d, "claude version 2.1.92 build abc"))).toEqual([2, 1, 92]);
  });

  it("returns null rather than guessing when the binary misbehaves", () => {
    const d = mkdtempSync(join(tmpdir(), "cbin-"));
    expect(claudeCliVersion(fakeClaude(d, "not a version"))).toBeNull();
    expect(claudeCliVersion(fakeClaude(d, "boom", 1))).toBeNull();
    expect(claudeCliVersion(join(d, "does-not-exist"))).toBeNull();
  });

  it("orders by component, so 2.1.251 beats 2.1.92 (a string compare gets this backwards)", () => {
    const d = mkdtempSync(join(tmpdir(), "cbin-a-"));
    const e = mkdtempSync(join(tmpdir(), "cbin-b-"));
    const newVer = claudeCliVersion(fakeClaude(d, "2.1.251 (Claude Code)"));
    const oldVer = claudeCliVersion(fakeClaude(e, "2.1.92 (Claude Code)"));
    expect(newVer).not.toBeNull();
    expect(oldVer).not.toBeNull();
    // The exact bug: "2.1.251" < "2.1.92" lexically.
    expect("2.1.251" < "2.1.92").toBe(true);
    expect((newVer as number[])[2] ?? 0).toBeGreaterThan((oldVer as number[])[2] ?? 0);
  });
});

// ADR-0093 — MARVIN never passes the binary to the SDK; the SDK resolves
// `claude` from PATH itself. With /opt/homebrew/bin prepended, every turn
// spawned 2.1.92 while discoverClaudeBinary() (and the About panel) reported
// 2.1.251. ADR-0087 fixed the REPORTING and left the SPAWN untouched, so the
// symptom survived that fix entirely.
describe("enrichedToolPath (ADR-0093)", () => {
  it("leads with the directory of the CLI we actually resolved", async () => {
    const { enrichedToolPath } = await import("../src/sdk-runner");
    const { discoverClaudeBinary } = await import("../src/claude-cli");
    const expected = discoverClaudeBinary().replace(/\/[^/]+$/, "");
    expect(enrichedToolPath("/usr/bin:/bin").split(":")[0]).toBe(expected);
  });

  it("still enriches for a Finder launch, and never duplicates an entry", async () => {
    const { enrichedToolPath } = await import("../src/sdk-runner");
    const parts = enrichedToolPath("/usr/bin:/bin").split(":");
    expect(parts).toContain("/opt/homebrew/bin");
    expect(parts).toContain("/usr/bin");
    expect(new Set(parts).size).toBe(parts.length);
  });
});
