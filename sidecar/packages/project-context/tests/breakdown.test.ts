import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  approxTokens,
  buildProjectContext,
  type ProjectContextResult,
} from "../src/index";

// Pins the /context breakdown contract: buildProjectContext returns both the
// exact injected text AND a per-category size estimate, and the category rows
// reflect what's actually in the text (sum ≤ the whole, scaffold unattributed).

const dirs: string[] = [];
function fixtureDir(): string {
  const d = mkdtempSync(join(tmpdir(), "marvin-ctx-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("buildProjectContext — breakdown", () => {
  it("returns text + a labeled breakdown reflecting injected docs and memory", async () => {
    const wd = fixtureDir();
    writeFileSync(join(wd, "README.md"), `# Demo\n\n${"x ".repeat(400)}`);
    mkdirSync(join(wd, ".marvin"), { recursive: true });
    writeFileSync(
      join(wd, ".marvin", "memory.md"),
      `# Memory\n\n- [fact](f.md) — ${"y ".repeat(300)}`,
    );

    const res: ProjectContextResult = await buildProjectContext({
      workDir: wd,
      firstMessage: true,
    });

    // text is the real injected block.
    expect(res.text).toContain("# Project context");
    expect(res.text).toContain("## README.md");

    // breakdown carries the doc + memory categories with real sizes.
    const labels = res.breakdown.map((b) => b.label);
    expect(labels).toContain("Project docs");
    expect(labels).toContain("Project memory");
    for (const row of res.breakdown) expect(row.approxTokens).toBeGreaterThan(0);

    // Categories sum to ≤ the whole (the markdown header/separators are
    // intentionally unattributed scaffold), and to a healthy fraction of it.
    const sum = res.breakdown.reduce((n, b) => n + b.approxTokens, 0);
    const whole = approxTokens(res.text);
    expect(sum).toBeLessThanOrEqual(whole);
    expect(sum).toBeGreaterThan(whole * 0.5);
  });

  it("injects CLAUDE.md, ahead of the other project docs", async () => {
    // The instruction file nearly every project already has. It was absent
    // from DEFAULT_FILES until 2026-08-31, so a user whose conventions lived
    // there watched MARVIN work as if they had never written them down.
    const wd = fixtureDir();
    writeFileSync(join(wd, "CLAUDE.md"), "# Rules\n\nAlways run the linter.");
    writeFileSync(join(wd, "README.md"), "# Readme\n\nWhat this project is.");

    const res = await buildProjectContext({ workDir: wd, firstMessage: true });

    expect(res.text).toContain("## CLAUDE.md");
    expect(res.text).toContain("Always run the linter.");
    // Instructions before description: how to work on it outranks what it is.
    expect(res.text.indexOf("## CLAUDE.md")).toBeLessThan(
      res.text.indexOf("## README.md"),
    );
  });

  it("does not inject CLAUDE.local.md", async () => {
    // The personal, never-committed override. Reading it is a separate
    // decision about whose machine's preferences steer a session.
    const wd = fixtureDir();
    writeFileSync(join(wd, "CLAUDE.local.md"), "# Mine\n\nSkip the tests.");

    const res = await buildProjectContext({ workDir: wd, firstMessage: true });
    expect(res.text).not.toContain("CLAUDE.local.md");
    expect(res.text).not.toContain("Skip the tests.");
  });

  it("returns an empty result (text + breakdown) when there is nothing to inject", async () => {
    const wd = fixtureDir(); // bare dir, no docs/memory/graph
    const res = await buildProjectContext({ workDir: wd, firstMessage: false });
    expect(res.text).toBe("");
    expect(res.breakdown).toEqual([]);
  });
});
