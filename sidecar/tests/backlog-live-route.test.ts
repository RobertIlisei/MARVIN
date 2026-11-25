import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addBacklogItem } from "@marvin/runtime/backlog";
import { createBacklogLive, setBacklogLiveForTests } from "@marvin/runtime/backlog-live";
import { addProject } from "@marvin/runtime/projects";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as CountsGET } from "../src/app/api/backlog/counts/route";
import { GET } from "../src/app/api/chat/announce/route";

// ADR-0044 addendum (2026-11-25) — the project's backlog counts ride the
// announce stream: the state at attach, then one `backlog.changed` per change,
// whoever made it. The strip in the chat used to read the count once.

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-live-data-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-live-proj-")));
  mkdirSync(path.join(workDir, ".marvin", "backlog"), { recursive: true });
  process.env.MARVIN_DATA_DIR = dataDir;
  setBacklogLiveForTests(createBacklogLive({ debounceMs: 40, maxWaitMs: 300 }));
});
afterEach(() => {
  setBacklogLiveForTests(null);
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

interface Frame {
  event: string;
  data: { revision?: number; reason?: string; counts?: Record<string, number>; projectId?: string };
}

/** Read frames off the SSE body until `until` says stop or the timeout passes. */
async function frames(res: Response, ctl: AbortController, until: (f: Frame[]) => boolean, ms = 3000): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: Frame[] = [];
  let buf = "";
  const deadline = Date.now() + ms;
  let pending: ReturnType<typeof reader.read> | null = null;
  while (Date.now() < deadline && !until(out)) {
    pending ??= reader.read(); // one outstanding read at a time, or a chunk goes to a discarded promise
    const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), 200))]);
    if (r === null) continue;
    pending = null;
    if (r.done) break;
    buf += dec.decode(r.value);
    for (;;) {
      const i = buf.indexOf("\n\n");
      if (i < 0) break;
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(raw)?.[1];
      const data = /^data: (.*)$/m.exec(raw)?.[1];
      if (ev && data) out.push({ event: ev, data: JSON.parse(data) });
    }
  }
  ctl.abort();
  return out;
}

const open = (projectId: string) => {
  const ctl = new AbortController();
  return GET(new NextRequest(`http://localhost:3030/api/chat/announce?projectId=${projectId}`, { signal: ctl.signal })).then((res) => ({ res, ctl }));
};

describe("GET /api/backlog/counts", () => {
  const get = (workDirParam: string | null) =>
    CountsGET(new NextRequest(`http://localhost:3030/api/backlog/counts${workDirParam === null ? "" : `?workDir=${encodeURIComponent(workDirParam)}`}`));

  it("answers the counts of a registered project", async () => {
    await addBacklogItem(workDir, { title: "one", body: "b" });
    await addBacklogItem(workDir, { title: "two", body: "b", provisional: true });
    addProject({ workDir });
    const res = await get(workDir);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ counts: { open: 1, provisional: 1, active: 2 } });
  });

  it("refuses a path that is not a registered project", async () => {
    expect((await get(workDir)).status).toBe(403);
    expect((await get(null)).status).toBe(400);
    expect((await get("relative/path")).status).toBe(400);
  });
});

describe("GET /api/chat/announce — backlog.changed", () => {
  it("sends the current counts right after attaching, then one change per write", async () => {
    await addBacklogItem(workDir, { title: "already parked", body: "b" });
    await new Promise((r) => setTimeout(r, 150)); // let that write's own signal go out before anyone listens
    const project = addProject({ workDir });
    const { res, ctl } = await open(project.id);
    const reading = frames(res, ctl, (f) => f.filter((x) => x.event === "backlog.changed").length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    await addBacklogItem(workDir, { title: "parked while connected", body: "b", provisional: true });
    const got = (await reading).filter((f) => f.event === "backlog.changed");
    expect(got).toHaveLength(2);
    expect(got[0]?.data).toMatchObject({ projectId: project.id, reason: "snapshot", counts: { active: 1, open: 1 } });
    expect(got[1]?.data).toMatchObject({ reason: "change", counts: { active: 2, provisional: 1 } });
    expect(got[1]?.data.revision).toBeGreaterThan(got[0]?.data.revision ?? 99);
  });

  it("a file written outside MARVIN reaches the same stream", async () => {
    const project = addProject({ workDir });
    const { res, ctl } = await open(project.id);
    const reading = frames(res, ctl, (f) => f.some((x) => x.data.reason === "change"));
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(
      path.join(workDir, ".marvin", "backlog", "by-hand.md"),
      "---\nid: by-hand\ntitle: by hand\nstatus: open\nseverity: low\nkind: chore\nblocked: false\n---\n\nx\n",
    );
    const change = (await reading).find((f) => f.data.reason === "change");
    expect(change?.data.counts).toMatchObject({ active: 1, open: 1 });
  });

  it("carries counts only: no path, no title", async () => {
    await addBacklogItem(workDir, { title: "secret title here", body: "b" });
    const project = addProject({ workDir });
    const { res, ctl } = await open(project.id);
    const got = await frames(res, ctl, (f) => f.some((x) => x.event === "backlog.changed"));
    const text = JSON.stringify(got);
    expect(text).not.toContain("secret title");
    expect(text).not.toContain(workDir);
  });

  it("an unknown project still gets its stream, without backlog events", async () => {
    const { res, ctl } = await open("no-such-project");
    const got = await frames(res, ctl, () => false, 500);
    expect(got.map((f) => f.event)).toEqual(["announce.attached"]);
  });
});
