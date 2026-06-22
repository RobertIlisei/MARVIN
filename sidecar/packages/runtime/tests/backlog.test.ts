import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_BODY_CHARS,
  MAX_OPEN_ITEMS,
  MAX_TITLE_CHARS,
  addBacklogItem,
  classifyBacklogText,
  listBacklog,
  resolveBacklogItem,
  setBacklogStatus,
} from "../src/backlog";

// ADR-0044 — the per-project backlog store. A durable parking lot for deferred
// work; one item → one file under .marvin/backlog/<slug>.md + a one-line index
// (open + doing only). Shared by the marvin-backlog MCP tool and /api/backlog.

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-backlog-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const indexPath = () => join(workDir, ".marvin", "backlog.md");
const itemPath = (slug: string) => join(workDir, ".marvin", "backlog", `${slug}.md`);

describe("backlog store — add / list / resolve", () => {
  it("add writes a slugged file + an index entry, status open", async () => {
    const res = await addBacklogItem(workDir, {
      title: "Tighten conformance test to flag handler⊆spec",
      body: "One-directional check lets handler-without-spec pass silently.",
      severity: "high",
      sessionId: "sess-1",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.item.status).toBe("open");
    expect(res.item.severity).toBe("high");
    expect(res.item.sessionId).toBe("sess-1");

    expect(existsSync(itemPath(res.item.id))).toBe(true);
    const index = await readFile(indexPath(), "utf-8");
    expect(index).toContain(res.item.title);
    expect(index).toContain("(high)");
    expect(index).toContain(`backlog/${res.item.id}.md`);
  });

  it("re-adding the same title dedups (updates in place, no second file)", async () => {
    const a = await addBacklogItem(workDir, { title: "Cache the computed field" });
    const b = await addBacklogItem(workDir, { title: "Cache the computed field", severity: "low" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.severity).toBe("low"); // updated in place
    const all = await listBacklog(workDir);
    expect(all).toHaveLength(1);
  });

  it("listBacklog filters by status", async () => {
    await addBacklogItem(workDir, { title: "Item one" });
    await addBacklogItem(workDir, { title: "Item two" });
    expect(await listBacklog(workDir, { status: "open" })).toHaveLength(2);
    expect(await listBacklog(workDir, { status: "done" })).toHaveLength(0);
  });

  it("resolve → done removes it from the index but keeps the file", async () => {
    const add = await addBacklogItem(workDir, { title: "Resolve me" });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const r = await resolveBacklogItem(workDir, { id: add.item.id, resolution: "done", note: "fixed" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("done");
    expect(existsSync(itemPath(add.item.id))).toBe(true); // file kept
    const index = await readFile(indexPath(), "utf-8");
    expect(index).not.toContain("Resolve me"); // dropped from index
    expect(index).toContain("_No open backlog items._");
    expect(r.item.body).toContain("fixed"); // note appended
  });

  it("setBacklogStatus → doing marks it in-progress in the index", async () => {
    const add = await addBacklogItem(workDir, { title: "Promote me" });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const r = await setBacklogStatus(workDir, add.item.id, "doing");
    expect(r.ok && r.item.status === "doing").toBe(true);
    const index = await readFile(indexPath(), "utf-8");
    expect(index).toContain("[~]");
    expect(index).toContain("Promote me");
  });

  it("re-adding a resolved item re-opens it", async () => {
    const add = await addBacklogItem(workDir, { title: "Recurring thing" });
    if (!add.ok) return;
    await resolveBacklogItem(workDir, { id: add.item.id, resolution: "dismissed" });
    const again = await addBacklogItem(workDir, { title: "Recurring thing" });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.item.status).toBe("open");
  });

  it("resolve on an unknown id errors", async () => {
    const r = await resolveBacklogItem(workDir, { id: "nope", resolution: "done" });
    expect(r.ok).toBe(false);
  });
});

describe("backlog store — provisional capture (ADR-0047)", () => {
  it("provisional add stores status=provisional and shows [?] in the index", async () => {
    const r = await addBacklogItem(workDir, { title: "Noticed a one-directional check", provisional: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.status).toBe("provisional");
    const index = await readFile(indexPath(), "utf-8");
    expect(index).toContain("[?]"); // resurfaces, marked needs-review
    expect(index).toContain("Noticed a one-directional check");
  });

  it("confirming a provisional item (provisional:false) promotes it to open", async () => {
    const a = await addBacklogItem(workDir, { title: "Tighten the retry path", provisional: true });
    if (!a.ok) return;
    expect(a.item.status).toBe("provisional");
    const b = await addBacklogItem(workDir, { title: "Tighten the retry path" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.item.status).toBe("open");
  });

  it("a provisional re-add never downgrades an already-open item", async () => {
    const a = await addBacklogItem(workDir, { title: "Add an integration test" });
    if (!a.ok) return;
    expect(a.item.status).toBe("open");
    const b = await addBacklogItem(workDir, { title: "Add an integration test", provisional: true });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.item.status).toBe("open"); // stays open
  });

  it("keep (setBacklogStatus → open) promotes a provisional item", async () => {
    const a = await addBacklogItem(workDir, { title: "Maybe cache this", provisional: true });
    if (!a.ok) return;
    const r = await setBacklogStatus(workDir, a.item.id, "open");
    expect(r.ok && r.item.status === "open").toBe(true);
  });

  it("provisional auto-capture bypasses the open-count rail (never silently dropped)", async () => {
    for (let i = 0; i < MAX_OPEN_ITEMS; i++) {
      const r = await addBacklogItem(workDir, { title: `open item ${i}` });
      expect(r.ok).toBe(true);
    }
    // A confirmed add is now blocked…
    expect((await addBacklogItem(workDir, { title: "confirmed overflow" })).ok).toBe(false);
    // …but a provisional discovery is still captured.
    const prov = await addBacklogItem(workDir, { title: "noticed past the cap", provisional: true });
    expect(prov.ok).toBe(true);
    if (!prov.ok) return;
    expect(prov.item.status).toBe("provisional");
  });
});

describe("backlog store — caps", () => {
  it("rejects an over-length title", async () => {
    const r = await addBacklogItem(workDir, { title: "x".repeat(MAX_TITLE_CHARS + 1) });
    expect(r.ok).toBe(false);
  });
  it("rejects an over-length body", async () => {
    const r = await addBacklogItem(workDir, { title: "ok", body: "y".repeat(MAX_BODY_CHARS + 1) });
    expect(r.ok).toBe(false);
  });
  it("rejects new items past the open-count rail", async () => {
    for (let i = 0; i < MAX_OPEN_ITEMS; i++) {
      const r = await addBacklogItem(workDir, { title: `item number ${i}` });
      expect(r.ok).toBe(true);
    }
    const over = await addBacklogItem(workDir, { title: "one too many" });
    expect(over.ok).toBe(false);
  });
});

describe("backlog content-class classifier (MCP write boundary)", () => {
  it("accepts an actionable follow-up", () => {
    expect(classifyBacklogText("Add a retry-path integration test", "").ok).toBe(true);
  });
  it("rejects verification/commit status", () => {
    expect(classifyBacklogText("tsc clean and vitest 1420/1420 passing", "").ok).toBe(false);
    expect(classifyBacklogText("changes not pushed yet", "").ok).toBe(false);
  });
  it("rejects a decision (belongs in an ADR)", () => {
    expect(classifyBacklogText("We decided to use SSE over polling", "").ok).toBe(false);
  });
});
