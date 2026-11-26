import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addProject } from "@marvin/runtime/projects";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as contentGET } from "../src/app/api/files/content/route";
import { GET as rawGET } from "../src/app/api/files/raw/route";
import { POST as savePOST } from "../src/app/api/files/write/save/route";

// 2026-11-26 — a tab linked /tmp/v3214-shots/….png; the viewer asked
// /api/files/content for it and got 400 path-escapes-cwd, which the app
// printed as "FilesServiceError error 0". Reading for display is allowed for a
// regular file under the system temp dirs; saving never is.

let dataDir: string;
let project: string;
let shots: string; // a "temp capture" dir — under tmpdir(), a viewable root
let outside: string; // a real directory under neither the project nor tmp
const prev = process.env.MARVIN_DATA_DIR;

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-view-route-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-view-route-proj-")));
  shots = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-view-route-shots-")));
  // The repo checkout this test runs from: outside the project and not under tmp.
  outside = path.resolve(__dirname, "..", "..");
  writeFileSync(path.join(shots, "capture.png"), PNG);
  writeFileSync(path.join(project, "inside.txt"), "hello");
  addProject({ workDir: project });
});
afterEach(() => {
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  for (const d of [dataDir, project, shots]) rmSync(d, { recursive: true, force: true });
});

function get(route: string, p: string): NextRequest {
  const u = new URL(`http://localhost:3030/api/files/${route}`);
  u.searchParams.set("cwd", project);
  u.searchParams.set("path", p);
  return new NextRequest(u, { headers: { "x-marvin-client": "1" } });
}

describe("GET /api/files/content", () => {
  it("shows a temp-dir capture a tab linked, flagged read-only and binary", async () => {
    const res = await contentGET(get("content", path.join(shots, "capture.png")));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.binary).toBe(true);
    expect(body.readOnly).toBe(true);
    expect(body.size).toBe(PNG.length);
  });

  it("a project file is not read-only", async () => {
    const res = await contentGET(get("content", "inside.txt"));
    expect(res.status).toBe(200);
    expect((await res.json()).readOnly).toBe(false);
  });

  it("refuses a file outside project and temp, with a sentence naming it", async () => {
    const target = path.join(outside, "package.json");
    const res = await contentGET(get("content", target));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("path-escapes-cwd");
    expect(body.message).toBe(`This file is outside the project and cannot be shown: ${target}`);
  });

  it("refuses a symlink in the temp dir that points at a file outside it", async () => {
    const link = path.join(shots, "passwd.png");
    symlinkSync("/etc/passwd", link);
    const res = await contentGET(get("content", link));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("symlink-rejected");
  });

  it("refuses a '..' walk from the temp dir to /etc/passwd", async () => {
    const res = await contentGET(get("content", `${shots}/../../../../../../etc/passwd`));
    expect(res.status).toBe(400);
  });

  it("refuses a temp-dir directory", async () => {
    mkdirSync(path.join(shots, "d"));
    const res = await contentGET(get("content", path.join(shots, "d")));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/files/raw", () => {
  it("streams the capture with its image type", async () => {
    const res = await rawGET(get("raw", path.join(shots, "capture.png")));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("still serves only previewable types", async () => {
    writeFileSync(path.join(shots, "notes.txt"), "x");
    const res = await rawGET(get("raw", path.join(shots, "notes.txt")));
    expect(res.status).toBe(415);
  });

  it("refuses outside project and temp with a message", async () => {
    const res = await rawGET(get("raw", path.join(outside, "package.json")));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain("outside the project");
  });
});

describe("POST /api/files/write/save", () => {
  it("never writes a temp-dir file, though the viewer can show it", async () => {
    const target = path.join(shots, "capture.png");
    const req = new NextRequest("http://localhost:3030/api/files/write/save", {
      method: "POST",
      headers: {
        "x-marvin-client": "1",
        origin: "http://localhost:3030",
        "content-type": "application/json",
      },
      body: JSON.stringify({ cwd: project, path: target, content: "overwritten" }),
    });
    const res = await savePOST(req);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(target).equals(PNG)).toBe(true);
  });
});
