import { describe, expect, it } from "vitest";

import { groomBacklog, renderGroomReport } from "../src/backlog-groom";
import type { BacklogItem } from "../src/backlog";

// ADR-0063 — the backlog groomer, Phase 1 of the backlog loop. It REVIEWS and
// reports; it never mutates. Thresholds and file existence are injected, so
// every case here is deterministic — no clock, no filesystem.

const NOW = new Date("2026-08-12T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function item(over: Partial<BacklogItem> & { id: string }): BacklogItem {
  return {
    id: over.id,
    title: over.title ?? over.id.replace(/-/g, " "),
    body: over.body ?? "",
    status: over.status ?? "open",
    severity: over.severity ?? "med",
    sessionId: "",
    created: over.created ?? daysAgo(1),
    updated: over.updated ?? daysAgo(1),
  };
}

const kinds = (items: BacklogItem[], opts = {}) =>
  groomBacklog(items, { now: NOW, ...opts }).findings.map((f) => `${f.kind}:${f.item.id}`);

describe("groomBacklog — what it flags", () => {
  it("flags a provisional item nobody ever reviewed", () => {
    const items = [item({ id: "never-reviewed", status: "provisional", created: daysAgo(20) })];
    expect(kinds(items)).toEqual(["unreviewed:never-reviewed"]);
  });

  it("does NOT flag a provisional item captured recently", () => {
    // Auto-capture is supposed to be un-gated; nagging about it same-day would
    // punish the behaviour ADR-0047 wants.
    const items = [item({ id: "fresh", status: "provisional", created: daysAgo(1) })];
    expect(kinds(items)).toEqual([]);
  });

  it("flags an item untouched past the stale threshold", () => {
    const items = [item({ id: "old", updated: daysAgo(45) })];
    expect(kinds(items)).toEqual(["stale:old"]);
  });

  it("flags a HIGH-severity item left sitting", () => {
    const items = [item({ id: "urgent", severity: "high", created: daysAgo(30), updated: daysAgo(1) })];
    expect(kinds(items)).toEqual(["aging-high-severity:urgent"]);
  });

  it("flags a reference to a file that no longer exists", () => {
    const items = [item({ id: "moved", body: "Fix the guard in src/gone.ts" })];
    expect(kinds(items, { fileExists: () => false })).toEqual(["dangling-reference:moved"]);
  });

  it("clusters duplicates and reports each cluster ONCE", () => {
    // Reported from both sides, a two-item cluster reads as two problems.
    const items = [
      item({ id: "a", title: "Fix the outline crash on refresh" }),
      item({ id: "b", title: "Fix the outline crash in the sidebar" }),
    ];
    const found = groomBacklog(items, { now: NOW }).findings.filter((f) => f.kind === "duplicate");
    expect(found).toHaveLength(1);
    expect(found[0]?.related.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("groomBacklog — what it deliberately leaves alone", () => {
  it("ignores resolved items entirely", () => {
    const items = [
      item({ id: "done-old", status: "done", updated: daysAgo(400) }),
      item({ id: "dismissed-old", status: "dismissed", updated: daysAgo(400) }),
    ];
    const r = groomBacklog(items, { now: NOW });
    expect(r.findings).toEqual([]);
    expect(r.live).toBe(0);
    expect(r.scanned).toBe(2);
  });

  it("skips the file check entirely when no fileExists is supplied", () => {
    // Without a workdir every path would look missing; one fewer check beats a
    // report full of phantoms.
    const items = [item({ id: "refs", body: "see src/whatever.ts" })];
    expect(kinds(items)).toEqual([]);
  });

  it("ignores a bare filename with no directory component", () => {
    // "README.md" can't be resolved to one file, so guessing would invent a
    // finding. Only paths written with a directory are checked.
    const items = [item({ id: "bare", body: "update README.md please" })];
    expect(kinds(items, { fileExists: () => false })).toEqual([]);
  });

  it("does not pile 'and it's also old' onto an item already flagged", () => {
    const items = [
      item({ id: "both", status: "provisional", created: daysAgo(60), updated: daysAgo(60) }),
    ];
    expect(kinds(items)).toEqual(["unreviewed:both"]);
  });

  it("survives an unparseable timestamp instead of throwing", () => {
    const items = [item({ id: "bad-date", created: "not-a-date", updated: "not-a-date" })];
    expect(() => groomBacklog(items, { now: NOW })).not.toThrow();
    expect(kinds(items)).toEqual([]);
  });
});

describe("groomBacklog — ordering and cap", () => {
  it("puts the most actionable kinds first", () => {
    const items = [
      item({ id: "z-stale", updated: daysAgo(90) }),
      item({ id: "y-unreviewed", status: "provisional", created: daysAgo(30) }),
      item({ id: "x-dup-1", title: "Fix the login redirect loop" }),
      item({ id: "x-dup-2", title: "Fix the redirect loop on login" }),
    ];
    const order = groomBacklog(items, { now: NOW }).findings.map((f) => f.kind);
    expect(order[0]).toBe("duplicate");
    expect(order.indexOf("unreviewed")).toBeLessThan(order.indexOf("stale"));
  });

  it("caps findings and SAYS it capped rather than implying a clean sweep", () => {
    const items = Array.from({ length: 10 }, (_, n) =>
      item({ id: `stale-${n}`, title: `unrelated subject ${n}`, updated: daysAgo(99) }),
    );
    const r = groomBacklog(items, { now: NOW, maxFindings: 3 });
    expect(r.findings).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(renderGroomReport(r)).toContain("capped");
  });
});

describe("renderGroomReport", () => {
  it("reports a healthy backlog plainly", () => {
    const r = groomBacklog([item({ id: "fine" })], { now: NOW });
    expect(renderGroomReport(r)).toMatch(/healthy/i);
  });

  it("tells the model these are heuristics and forbids acting on them", () => {
    const r = groomBacklog([item({ id: "old", updated: daysAgo(60) })], { now: NOW });
    const text = renderGroomReport(r);
    expect(text).toMatch(/heuristic/i);
    expect(text).toMatch(/do not resolve, merge, re-prioritise, or edit/i);
    expect(text).toContain("`old`");
  });
});
