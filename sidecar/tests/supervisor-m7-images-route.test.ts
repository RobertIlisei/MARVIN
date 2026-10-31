import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addProject } from "@marvin/runtime/projects";
import { readLedger } from "@marvin/runtime/supervisor-ledger";
import { defaultLoopDeps, SupervisorLoop } from "@marvin/runtime/supervisor-loop";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as messageGET, POST as messagePOST } from "../src/app/api/supervisor/message/route";

// ADR-0129 — the route's image surface: what it accepts, what it refuses, where
// the bytes go, and what the app reads back.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]);
const img = (b: Buffer, mediaType = "image/png") => ({ mediaType, data: b.toString("base64") });

let dataDir: string;
let workDir: string;
let P: string;
let loop: SupervisorLoop;
const prev = process.env.MARVIN_DATA_DIR;
const G = globalThis as typeof globalThis & { __marvinSupervisorLoop?: SupervisorLoop };
const realLoop = G.__marvinSupervisorLoop;
const token = () => currentSupervisorToken() as string;
const BASE = "http://localhost:3030";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-imgr-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-imgr-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  P = addProject({ name: "proj", workDir }).id;
  applySupervisorAction({ projectId: P, action: "start" }, token());
  // No model: the wake does nothing; these tests are about the route.
  loop = new SupervisorLoop({ ...defaultLoopDeps(), runWake: async () => ({ ok: true, costUsd: 0 }) });
  loop.start();
  G.__marvinSupervisorLoop = loop;
});
afterEach(() => {
  loop.stop();
  G.__marvinSupervisorLoop = realLoop;
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const post = (body: unknown) =>
  new NextRequest(`${BASE}/api/supervisor/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-marvin-client": "1", "x-marvin-supervisor-token": token() },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const list = async () =>
  ((await (await messageGET(new NextRequest(`${BASE}/api/supervisor/message?projectId=${P}`, { headers: { "x-marvin-supervisor-token": token() } }))).json()) as {
    messages: Array<{ id: string; text: string; attachments?: Array<{ id: string; mediaType: string; bytes: number; path: string }> }>;
  }).messages;

describe("POST /api/supervisor/message with images", () => {
  it("stores the images 0600 under the data dir and GET gives the app a path to them", async () => {
    const r = await messagePOST(post({ projectId: P, text: "what is wrong here?", images: [img(PNG), img(JPEG, "image/jpeg")] }));
    expect(r.status).toBe(200);
    const [m] = await list();
    expect(m?.attachments?.map((a) => a.mediaType)).toEqual(["image/png", "image/jpeg"]);
    for (const a of m?.attachments ?? []) {
      expect(a.path.startsWith(realpathSync(dataDir)) || a.path.startsWith(dataDir)).toBe(true);
      expect(a.path.startsWith(workDir)).toBe(false);
      expect(statSync(a.path).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(m!.attachments![0]!.path).equals(PNG)).toBe(true);
    expect(readLedger(P).find((e) => e.verb === "message")?.argSummary).toMatch(/2 images/);
  });

  it("an image may stand without words; no words and no image is still refused", async () => {
    expect((await messagePOST(post({ projectId: P, text: "", images: [img(PNG)] }))).status).toBe(200);
    expect((await list())[0]?.text).toBe("");
    expect((await messagePOST(post({ projectId: P, text: "  " }))).status).toBe(400);
    expect((await messagePOST(post({ projectId: P, text: "", images: [] }))).status).toBe(400);
  });

  it("refuses a type the bytes contradict, an off-list type, and more than four images — writing nothing", async () => {
    expect((await messagePOST(post({ projectId: P, text: "x", images: [img(JPEG, "image/png")] }))).status).toBe(400);
    expect((await messagePOST(post({ projectId: P, text: "x", images: [img(Buffer.from("GIF89a-----"), "image/gif")] }))).status).toBe(400);
    expect((await messagePOST(post({ projectId: P, text: "x", images: Array.from({ length: 5 }, () => img(PNG)) }))).status).toBe(400);
    expect(await list()).toEqual([]);
    expect(existsSync(path.join(dataDir, "supervisor", P, "attachments"))).toBe(false);
  });

  it("measures the body in bytes, not characters", async () => {
    // 6M three-byte characters: 6M UTF-16 units, 18M bytes on the wire.
    const big = JSON.stringify({ projectId: P, text: "€".repeat(7_500_000) });
    const r = await messagePOST(post(big));
    expect(r.status).toBe(413);
  });

  it("refuses an image the app's text recognition found a secret in", async () => {
    const r = await messagePOST(post({ projectId: P, text: "my terminal", images: [img(PNG)], imageText: ["export ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/secret/);
    expect(await list()).toEqual([]);
  });

  it("a text-only message is unchanged", async () => {
    const r = await messagePOST(post({ projectId: P, text: "hello" }));
    expect(r.status).toBe(200);
    expect((await list())[0]).not.toHaveProperty("attachments");
  });
});
