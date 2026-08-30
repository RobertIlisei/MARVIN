import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { progressLabel, rewritePlansIndex, summarisePlan } from "../src/plans-index";

// ADR-0091 — memory and backlog each wikilink their notes; plans had no index
// at all, so 353 notes on a real project had not one inbound link.

describe("summarisePlan", () => {
  it("takes the heading as the title and strips the 'Plan —' prefix", () => {
    const p = summarisePlan("close-the-3-open-items", "# Plan — Close the 3 open items\n\ntext");
    expect(p.title).toBe("Close the 3 open items");
  });

  it("handles an en-dash, a hyphen, and a heading with no prefix", () => {
    expect(summarisePlan("s", "# Plan – With en dash").title).toBe("With en dash");
    expect(summarisePlan("s", "# Plan - With hyphen").title).toBe("With hyphen");
    expect(summarisePlan("s", "# Just a title").title).toBe("Just a title");
  });

  it("falls back to the slug when there is no heading", () => {
    expect(summarisePlan("some-plan-slug", "no heading here").title).toBe("some plan slug");
  });

  it("counts checkboxes at any indent — ADR-0046 sub-tasks are work too", () => {
    const md = [
      "# Plan — x",
      "1. [ ] top level is not a checkbox list item",
      "- [x] done one",
      "- [ ] open one",
      "  - [x] nested done",
      "  - [ ] nested open",
      "* [x] star bullet done",
    ].join("\n");
    const p = summarisePlan("x", md);
    expect(p.total).toBe(5);
    expect(p.done).toBe(3);
  });

  it("reports no progress for a plan with no checkboxes", () => {
    const p = summarisePlan("x", "# Plan — prose only\n\njust text");
    expect(p.total).toBe(0);
    expect(progressLabel(p)).toBe("");
  });

  it("marks a finished plan distinctly from one in progress", () => {
    expect(progressLabel({ slug: "a", title: "t", done: 2, total: 5 })).toBe("2/5");
    expect(progressLabel({ slug: "a", title: "t", done: 5, total: 5 })).toBe("✓ 5/5");
  });
});

describe("rewritePlansIndex", () => {
  async function seed(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "plans-"));
    await mkdir(join(dir, ".marvin", "plans"), { recursive: true });
    return dir;
  }

  it("writes wikilinks, not markdown links — only wikilinks create graph edges", async () => {
    const dir = await seed();
    await writeFile(join(dir, ".marvin", "plans", "alpha.md"), "# Plan — Alpha\n- [x] a\n- [ ] b\n");
    const n = await rewritePlansIndex(dir);
    expect(n).toBe(1);
    const index = await readFile(join(dir, ".marvin", "plans.md"), "utf-8");
    expect(index).toContain("[[plans/alpha|Alpha]] — 1/2");
    expect(index).not.toMatch(/\]\(plans\//); // no markdown links
  });

  it("orders newest first — a plans list is read to find recent work", async () => {
    const dir = await seed();
    const p = join(dir, ".marvin", "plans");
    await writeFile(join(p, "older.md"), "# Plan — Older\n");
    await new Promise((r) => setTimeout(r, 15));
    await writeFile(join(p, "newer.md"), "# Plan — Newer\n");
    await rewritePlansIndex(dir);
    const index = await readFile(join(dir, ".marvin", "plans.md"), "utf-8");
    expect(index.indexOf("Newer")).toBeLessThan(index.indexOf("Older"));
  });

  it("is a no-op on a project with no plans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plans-none-"));
    expect(await rewritePlansIndex(dir)).toBe(0);
  });

  it("regenerates in place rather than appending", async () => {
    const dir = await seed();
    await writeFile(join(dir, ".marvin", "plans", "a.md"), "# Plan — A\n");
    await rewritePlansIndex(dir);
    await rewritePlansIndex(dir);
    const index = await readFile(join(dir, ".marvin", "plans.md"), "utf-8");
    expect(index.match(/\[\[plans\/a\|A\]\]/g)).toHaveLength(1);
  });
});
