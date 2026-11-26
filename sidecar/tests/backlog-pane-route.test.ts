import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createBacklogLive, setBacklogLiveForTests } from "@marvin/runtime/backlog-live";
import { addProject } from "@marvin/runtime/projects";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET, PATCH, POST } from "../src/app/api/backlog/route";

// ADR-0044 addendum (2026-11-27) — the pane's data route answers the counts and
// the OPEN items without reading a closed file; the Resolved tab pages the closed index
// on demand, newest first.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-pane-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-pane-proj-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  setBacklogLiveForTests(createBacklogLive({ debounceMs: 20, maxWaitMs: 100 }));
  addProject({ workDir });
});
afterEach(() => {
  setBacklogLiveForTests(null);
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

function file(id: string, status: string, severity = "med", updated = "2026-11-01T00:00:00.000Z"): string {
  return `---\nid: ${id}\ntitle: ${id}\nstatus: ${status}\nseverity: ${severity}\nkind: bug\nblocked: false\nblockedOn: \nsessionId: s\ncreated: 2026-10-01T00:00:00.000Z\nupdated: ${updated}\n---\n\nbody ${id}\n`;
}

async function seed(open: number, done: number, dismissed: number, ordered = false): Promise<void> {
  const dir = path.join(workDir, ".marvin", "backlog");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < open; i++) writeFileSync(path.join(dir, `open-${i}.md`), file(`open-${i}`, i === 0 ? "provisional" : "open", i % 3 === 0 ? "high" : "med"));
  for (let i = 0; i < done; i++) writeFileSync(path.join(dir, `done-${String(i).padStart(3, "0")}.md`), file(`done-${String(i).padStart(3, "0")}`, "done", "med", ordered ? new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() : undefined));
  for (let i = 0; i < dismissed; i++) writeFileSync(path.join(dir, `dismissed-${i}.md`), file(`dismissed-${i}`, "dismissed"));
}

const get = (qs: string) => GET(new NextRequest(`http://localhost:3030/api/backlog?workDir=${encodeURIComponent(workDir)}${qs}`));
const send = (method: typeof POST | typeof PATCH, body: object) =>
  method(
    new NextRequest("http://localhost:3030/api/backlog", {
      method: method === POST ? "POST" : "PATCH",
      headers: { "content-type": "application/json", "x-marvin-client": "1" },
      body: JSON.stringify({ workDir, ...body }),
    }),
  );

describe("GET /api/backlog — the pane's data", () => {
  it("returns the counts and the open items only; resolved items are counted, not loaded", async () => {
    await seed(7, 240, 31);
    const res = await get("");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(7);
    expect(body.items.every((i: { status: string }) => ["open", "doing", "provisional"].includes(i.status))).toBe(true);
    expect(body.counts).toMatchObject({ provisional: 1, open: 6, done: 240, dismissed: 31, active: 7 });
    expect(body.resolved).toEqual({ done: 240, dismissed: 31, total: 271 });
  });

  it("rows carry the normalised severity, and the old `med` the pane still reads", async () => {
    await seed(2, 0, 0);
    const { items } = await (await get("")).json();
    expect(items.find((i: { id: string }) => i.id === "open-1")).toMatchObject({ severity: "med" });
    expect(items.find((i: { id: string }) => i.id === "open-0")).toMatchObject({ severity: "high" });
    expect(items[0]).not.toHaveProperty("priority");
  });

  it("counts the closed items from the closed index, not by reading their files", async () => {
    await seed(1, 5, 0);
    await get(""); // builds the closed index
    // Rewrite every closed file as "dismissed" and restore its mtime and size: a route that read the files would now say so.
    const dir = path.join(workDir, ".marvin", "backlog");
    const { statSync, utimesSync } = await import("node:fs");
    for (let i = 0; i < 5; i++) {
      const f = path.join(dir, `done-${String(i).padStart(3, "0")}.md`);
      const st = statSync(f);
      const text = file(`done-${String(i).padStart(3, "0")}`, "done").replace("status: done", "status: done");
      writeFileSync(f, text.padEnd(st.size, " "));
      utimesSync(f, st.atime, st.mtime);
    }
    const body = await (await get("")).json();
    expect(body.resolved).toEqual({ done: 5, dismissed: 0, total: 5 });
    expect(body.counts.done).toBe(5);
  });
});

describe("GET /api/backlog?status=resolved — a page at a time", () => {
  it("pages the closed items newest first, 100 by default, with hasMore until the end", async () => {
    await seed(0, 250, 0, true); // `updated` rises with the number: done-249 is the newest
    const p1 = await (await get("&status=resolved")).json();
    expect(p1.items).toHaveLength(100);
    expect(p1).toMatchObject({ total: 250, offset: 0, hasMore: true });
    expect(p1.items[0].id).toBe("done-249"); // newest first
    const p2 = await (await get("&status=resolved&offset=100")).json();
    expect(p2.items[0].id).toBe("done-149");
    const p3 = await (await get("&status=resolved&offset=200&limit=100")).json();
    expect(p3.items).toHaveLength(50);
    expect(p3.hasMore).toBe(false);
    const seen = new Set([...p1.items, ...p2.items, ...p3.items].map((i: { id: string }) => i.id));
    expect(seen.size).toBe(250);
  });

  it("filters to done or dismissed", async () => {
    await seed(0, 3, 4);
    const body = await (await get("&status=dismissed&limit=2")).json();
    expect(body.items).toHaveLength(2);
    expect(body).toMatchObject({ total: 4, hasMore: true });
  });
});

describe("writes through the route", () => {
  it("accepts the pane's old spelling (`severity: med`) and stores `medium`", async () => {
    await seed(1, 0, 0);
    const res = await send(PATCH, { id: "open-0", severity: "med" });
    expect(res.status).toBe(200);
    expect((await res.json()).item).toMatchObject({ severity: "med" }); // medium, in the spelling the pane reads
    expect(readFileSync(path.join(workDir, ".marvin", "backlog", "open-0.md"), "utf-8")).toMatch(/^severity: medium$/m);
  });

  it("refuses a severity that is not one, with the three values named; `priority` is accepted as the name", async () => {
    await seed(1, 0, 0);
    expect((await send(PATCH, { id: "open-0", priority: "high" })).status).toBe(200);
    const res = await send(PATCH, { id: "open-0", severity: "urgent-ish" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("low, medium, high");
    const add = await send(POST, { title: "Bad one", severity: "p0-ish" });
    expect(add.status).toBe(400);
  });

  it("resolving through PATCH moves the item to the closed index and the counts follow", async () => {
    await seed(2, 0, 0);
    expect((await send(PATCH, { id: "open-1", status: "done" })).status).toBe(200);
    const body = await (await get("")).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["open-0"]);
    expect(body.resolved).toEqual({ done: 1, dismissed: 0, total: 1 });
    const page = await (await get("&status=resolved")).json();
    expect(page.items.map((i: { id: string }) => i.id)).toEqual(["open-1"]);
  });
});
