import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_BODY_CHARS,
  MAX_OPEN_ITEMS,
  MAX_TITLE_CHARS,
  RELATED_MAX,
  addBacklogItem,
  backlogSimilarity,
  classifyBacklogText,
  listBacklog,
  relatedBacklogItems,
  resolveBacklogItem,
  setBacklogStatus,
  updateBacklogItem,
  type BacklogItem,
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

  it("updateBacklogItem edits severity and replaces body by id (detail view)", async () => {
    const add = await addBacklogItem(workDir, {
      title: "Edit me",
      body: "original body",
      severity: "low",
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;

    const sev = await updateBacklogItem(workDir, add.item.id, { severity: "high" });
    expect(sev.ok && sev.item.severity === "high").toBe(true);
    if (sev.ok) expect(sev.item.body).toBe("original body"); // body untouched

    const bod = await updateBacklogItem(workDir, add.item.id, { body: "rewritten body" });
    expect(bod.ok && bod.item.body === "rewritten body").toBe(true);
    if (bod.ok) expect(bod.item.severity).toBe("high"); // severity preserved

    const index = await readFile(indexPath(), "utf-8");
    expect(index).toContain("(high)"); // index rewritten with new severity

    const both = await updateBacklogItem(workDir, add.item.id, {
      severity: "med",
      body: `${"x".repeat(MAX_BODY_CHARS + 100)}`,
    });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.item.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS); // cap holds

    const missing = await updateBacklogItem(workDir, "no-such-id", { severity: "low" });
    expect(missing.ok).toBe(false);
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

  // Explicit timeout: this fills the rail with MAX_OPEN_ITEMS (200) sequential
  // adds, each a real file write + index rebuild — ~400 filesystem ops. It runs
  // in ~1.3 s on a local SSD but exceeded vitest's 5 s default on GitHub's
  // slower runners, which is why the `test` workflow went red from v0.1.56 (the
  // release that raised the rail 50 → 200) and stayed red for four releases.
  // The test isn't wrong and the product isn't slow; the default was just tight
  // for I/O of this size. 30 s leaves headroom without masking a genuine hang.
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
  }, 30_000);
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
  // Same rail-filling cost as the provisional test above — see the note there
  // for why the default 5 s timeout was too tight on CI runners.
  it("rejects new items past the open-count rail", async () => {
    for (let i = 0; i < MAX_OPEN_ITEMS; i++) {
      const r = await addBacklogItem(workDir, { title: `item number ${i}` });
      expect(r.ok).toBe(true);
    }
    const over = await addBacklogItem(workDir, { title: "one too many" });
    expect(over.ok).toBe(false);
  }, 30_000);
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

// ADR-0044 addendum — overlap detection. Exact-slug dedup can't see two items
// that describe the same work in different words, and un-gated capture at
// discovery (ADR-0047) makes those accumulate. Detection is SURFACE-ONLY:
// nothing here may mutate a sibling.

function item(over: Partial<BacklogItem> & { title: string }): BacklogItem {
  return {
    id: over.id ?? over.title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title: over.title,
    body: over.body ?? "",
    status: over.status ?? "open",
    kind: over.kind ?? "unspecified",
    blocked: over.blocked ?? false,
    blockedOn: over.blockedOn ?? "",
    severity: over.severity ?? "med",
    sessionId: "",
    created: "2026-08-06T00:00:00.000Z",
    updated: "2026-08-06T00:00:00.000Z",
  };
}

describe("backlog overlap — similarity calibration", () => {
  it("scores a reworded duplicate as related", () => {
    const a = item({ title: "Fix the file-tree outline crash on refresh" });
    const b = item({ title: "Stop the outline crashing when the tree refreshes" });
    expect(backlogSimilarity(a, b)).toBeGreaterThanOrEqual(0.5);
  });

  it("scores unrelated work as unrelated", () => {
    const a = item({ title: "Fix the file-tree outline crash on refresh" });
    const b = item({ title: "Add a retry path to the cost tracker upload" });
    expect(backlogSimilarity(a, b)).toBeLessThan(0.5);
  });

  it("treats a shared file path as strong but not sufficient evidence", () => {
    const shared = item({ title: "Widen the sidebar indent", body: "In FileTreeView.swift" });
    const other = item({ title: "Cache git badges per turn", body: "See FileTreeView.swift:412" });
    // Same file, genuinely different work — must not be reported.
    expect(backlogSimilarity(shared, other)).toBeLessThan(0.5);
    // Same file AND overlapping vocabulary — reported.
    const closer = item({ title: "Cache the sidebar indent guides", body: "FileTreeView.swift" });
    expect(backlogSimilarity(shared, closer)).toBeGreaterThanOrEqual(0.5);
  });

  it("is not fooled by shared imperative verbs alone", () => {
    const a = item({ title: "Fix the login redirect" });
    const b = item({ title: "Fix the export button" });
    expect(backlogSimilarity(a, b)).toBeLessThan(0.5);
  });

  it("ignores version strings and prose abbreviations as file paths", () => {
    const a = item({ title: "Bump the runtime", body: "we shipped 0.1.60, e.g. the cask" });
    const b = item({ title: "Retune the poller", body: "was 0.1.60, e.g. every 15s" });
    expect(backlogSimilarity(a, b)).toBeLessThan(0.5);
  });
});

describe("backlog overlap — relatedBacklogItems", () => {
  const target = item({ title: "Fix the outline crash", id: "fix-the-outline-crash" });

  it("excludes itself, and resolved items", () => {
    const others = [
      target,
      item({ title: "Fix the outline crash on refresh", id: "dup-done", status: "done" }),
      item({ title: "Fix the outline crash in the sidebar", id: "dup-dismissed", status: "dismissed" }),
    ];
    expect(relatedBacklogItems(target, others)).toEqual([]);
  });

  it("includes provisional and doing items", () => {
    const others = [
      item({ title: "Fix the outline crash on refresh", id: "dup-prov", status: "provisional" }),
      item({ title: "Fix the outline crash in the sidebar", id: "dup-doing", status: "doing" }),
    ];
    expect(relatedBacklogItems(target, others).map((i) => i.id).sort()).toEqual([
      "dup-doing",
      "dup-prov",
    ]);
  });

  it("caps the number of candidates", () => {
    const others = Array.from({ length: RELATED_MAX + 4 }, (_, n) =>
      item({ title: `Fix the outline crash variant ${n}`, id: `dup-${n}` }),
    );
    expect(relatedBacklogItems(target, others)).toHaveLength(RELATED_MAX);
  });
});

describe("backlog overlap — reported at the write boundary, never applied", () => {
  it("add reports a near-duplicate the slug dedup cannot see", async () => {
    const first = await addBacklogItem(workDir, {
      title: "Fix the file-tree outline crash on refresh",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.related).toEqual([]);

    const second = await addBacklogItem(workDir, {
      title: "Stop the outline crashing when the tree refreshes",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Different slug — so it IS parked, and both files exist...
    expect(second.item.id).not.toBe(first.item.id);
    expect(existsSync(itemPath(first.item.id))).toBe(true);
    expect(existsSync(itemPath(second.item.id))).toBe(true);
    // ...but the overlap is reported rather than silently dropped.
    expect(second.related.map((i) => i.id)).toEqual([first.item.id]);
  });

  it("resolve reports still-live siblings WITHOUT touching them", async () => {
    const a = await addBacklogItem(workDir, { title: "Fix the outline crash on refresh" });
    const b = await addBacklogItem(workDir, { title: "Fix the outline crash in the sidebar" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const res = await resolveBacklogItem(workDir, { id: a.item.id, resolution: "done" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.related?.map((i) => i.id)).toEqual([b.item.id]);

    // THE INVARIANT: the sibling is untouched — same status, same updated stamp.
    const after = (await listBacklog(workDir)).find((i) => i.id === b.item.id);
    expect(after?.status).toBe("open");
    expect(after?.updated).toBe(b.item.updated);
    // And it is still listed in the active index.
    expect(await readFile(indexPath(), "utf-8")).toContain(b.item.title);
  });

  it("reports nothing when the backlog holds unrelated work", async () => {
    await addBacklogItem(workDir, { title: "Add a retry path to the cost tracker" });
    const res = await addBacklogItem(workDir, { title: "Widen the sidebar indent guides" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.related).toEqual([]);
  });
});

describe("backlog store — kind + blocked (ADR-0064)", () => {
  it("defaults to unspecified/not-blocked, and round-trips through the file", async () => {
    const a = await addBacklogItem(workDir, { title: "Plain item" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.item.kind).toBe("unspecified");
    expect(a.item.blocked).toBe(false);

    const b = await addBacklogItem(workDir, {
      title: "Classified item",
      kind: "bug",
      blocked: true,
      blockedOn: "vendor patch",
    });
    if (!b.ok) return;
    const reread = (await listBacklog(workDir)).find((i) => i.id === b.item.id);
    expect(reread?.kind).toBe("bug");
    expect(reread?.blocked).toBe(true);
    expect(reread?.blockedOn).toBe("vendor patch");
  });

  it("BACK-COMPAT: an item file written before these fields still parses", async () => {
    // The 430 existing items have no kind/blocked lines. Missing must mean
    // "unspecified", never a guess — a guessed kind makes filters silently wrong.
    const dir = join(workDir, ".marvin", "backlog");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "legacy.md"),
      "---\nid: legacy\ntitle: An older item\nstatus: open\nseverity: high\n" +
        "sessionId: \ncreated: 2026-01-01T00:00:00.000Z\nupdated: 2026-01-01T00:00:00.000Z\n---\n\nbody\n",
      "utf-8",
    );
    const item = (await listBacklog(workDir)).find((i) => i.id === "legacy");
    expect(item?.kind).toBe("unspecified");
    expect(item?.blocked).toBe(false);
    expect(item?.severity).toBe("high"); // unrelated fields still parse
  });

  it("an omitted kind on re-add KEEPS the existing classification", async () => {
    // A provisional confirm or a re-add must not wipe what the user set.
    const a = await addBacklogItem(workDir, { title: "Keep my kind", kind: "docs" });
    if (!a.ok) return;
    const b = await addBacklogItem(workDir, { title: "Keep my kind", severity: "high" });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.item.kind).toBe("docs");
    expect(b.item.severity).toBe("high");
  });

  it("updateBacklogItem edits kind/blocked without touching status", async () => {
    const a = await addBacklogItem(workDir, { title: "Reclassify me" });
    if (!a.ok) return;
    const r = await updateBacklogItem(workDir, a.item.id, { kind: "test", blocked: true, blockedOn: "CI" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.kind).toBe("test");
    expect(r.item.blocked).toBe(true);
    expect(r.item.status).toBe("open"); // untouched
  });
});

describe("backlog store — classification must not reset the staleness clock", () => {
  it("a kind/blocked edit leaves `updated` alone", async () => {
    // Regression (2026-08-14): a classification pass over 58 items bumped every
    // `updated`, which silenced 9 stale findings and every aging-bug for a
    // month — and looked like the new kind-exemptions working.
    const a = await addBacklogItem(workDir, { title: "Do not touch my clock" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const before = a.item.updated;

    const r = await updateBacklogItem(workDir, a.item.id, { kind: "bug", blocked: true, blockedOn: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.kind).toBe("bug");
    expect(r.item.updated).toBe(before);
  });

  it("a body or severity edit DOES bump it — that's real engagement", async () => {
    const a = await addBacklogItem(workDir, { title: "Substance changed" });
    if (!a.ok) return;
    await new Promise((r) => setTimeout(r, 5));
    const r = await updateBacklogItem(workDir, a.item.id, { body: "new detail" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.updated).not.toBe(a.item.updated);
  });
});
