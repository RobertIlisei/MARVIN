import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { approxTokens, buildProjectContext } from "../src/index";

// ADR-0118 Milestone 2 / Golden Rule 5 as amended 2026-09-21: project DOCS
// load whole; the three INDEXES (ADR titles, memory, backlog) load as their
// most recent slice plus the exact tool that fetches the rest. Measured on
// agri-saas-platform: 8.5K + 8.1K + 3.4K tokens of index on every session.

const dirs: string[] = [];
function fixtureDir(): string {
  const d = mkdtempSync(join(tmpdir(), "marvin-ctx-index-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + heading.length);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

describe("buildProjectContext — indexes load as a recent slice", () => {
  it("lists only the most recent ADRs, states the total, and names how to find the rest", async () => {
    const wd = fixtureDir();
    const adr = join(wd, "docs", "adr");
    mkdirSync(adr, { recursive: true });
    for (let i = 1; i <= 30; i += 1) {
      const n = String(i).padStart(4, "0");
      const p = join(adr, `${n}-decision-${i}.md`);
      writeFileSync(p, `# ADR-${n}: Decision number ${i}\n`);
      utimesSync(p, 1_700_000_000 + i, 1_700_000_000 + i);
    }
    const { text } = await buildProjectContext({ workDir: wd, firstMessage: true });
    const block = section(text, "## Architecture Decision Records");
    expect(block).toContain("30");
    expect(block).toContain("Decision number 30");
    expect(block).toContain("Decision number 11");
    expect(block).not.toContain("Decision number 10\n");
    expect(block).toContain('scope:"knowledge"');
  });

  it("keeps a short memory index whole", async () => {
    const wd = fixtureDir();
    mkdirSync(join(wd, ".marvin"), { recursive: true });
    writeFileSync(join(wd, ".marvin", "memory.md"), "# Memory\n\n- [a](a.md) — fact A\n- [b](b.md) — fact B\n");
    const { text } = await buildProjectContext({ workDir: wd, firstMessage: true });
    const block = section(text, "## Project memory");
    expect(block).toContain("fact A");
    expect(block).toContain("fact B");
    expect(block).not.toContain("recent tail");
  });

  it("clips a long memory index to its newest ~2.5K tokens and points at recall", async () => {
    const wd = fixtureDir();
    mkdirSync(join(wd, ".marvin"), { recursive: true });
    const lines = Array.from({ length: 400 }, (_, i) => `- [f${i}](f${i}.md) — durable fact number ${i} about the system`);
    writeFileSync(join(wd, ".marvin", "memory.md"), `# Memory\n\n${lines.join("\n")}\n`);
    const { text } = await buildProjectContext({ workDir: wd, firstMessage: true });
    const block = section(text, "## Project memory");
    expect(block).toContain("durable fact number 399");
    expect(block).not.toContain("durable fact number 0 ");
    expect(block).toContain("`recall`");
    expect(approxTokens(block)).toBeLessThan(3200);
  });

  it("clips a long backlog to its newest ~1K tokens and points at backlog_list", async () => {
    const wd = fixtureDir();
    mkdirSync(join(wd, ".marvin"), { recursive: true });
    const items = Array.from({ length: 200 }, (_, i) => `- [item ${i}](backlog/i${i}.md) — follow-up work item ${i}`);
    writeFileSync(join(wd, ".marvin", "backlog.md"), `# Backlog\n\n${items.join("\n")}\n`);
    const { text } = await buildProjectContext({ workDir: wd, firstMessage: true });
    const block = section(text, "## Project backlog");
    expect(block).toContain("follow-up work item 199");
    expect(block).toContain("`backlog_list`");
    expect(approxTokens(block)).toBeLessThan(1600);
  });
});
