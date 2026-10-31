import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { addProject } from "@marvin/runtime/projects";
import { readLedger } from "@marvin/runtime/supervisor-ledger";
import { defaultLoopDeps, SupervisorLoop } from "@marvin/runtime/supervisor-loop";
import { createSupervisorVerbs } from "../packages/runtime/src/supervisor-mcp";
import type { WakeItem } from "../packages/runtime/src/supervisor-prompt";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, resetSupervisorStateForTests } from "@marvin/runtime/supervisor-state";
import { type ProjectEvent, subscribeProjectEvents } from "@marvin/runtime/turn-registry";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as messageGET, POST as messagePOST } from "../src/app/api/supervisor/message/route";

// ADR-0128 / plan [7.1] DoD "one message, one reply, end to end": the route,
// the real loop, a stubbed model that calls the real `reply` verb, the ledger,
// and the GET the Supervisor tab renders.

let dataDir: string;
let workDir: string;
let P: string;
let loop: SupervisorLoop;
const prev = process.env.MARVIN_DATA_DIR;
const G = globalThis as typeof globalThis & { __marvinSupervisorLoop?: SupervisorLoop };
const realLoop = G.__marvinSupervisorLoop;
const token = () => currentSupervisorToken() as string;
const BASE = "http://localhost:3030";
let wakes: WakeItem[][];

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-m7c-"));
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "marvin-sup-m7c-work-")));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  P = addProject({ name: "proj", workDir }).id;
  applySupervisorAction({ projectId: P, action: "start", delegations: [{ sessionId: "tab-1", level: "answer-questions" }] }, token());
  wakes = [];
  // The stubbed model: it reads its packet and answers with the real verb.
  loop = new SupervisorLoop({
    ...defaultLoopDeps(),
    runWake: async ({ items, verbCtx }) => {
      wakes.push(items);
      await createSupervisorVerbs(verbCtx).reply({ text: `Read you: ${items[0]?.message?.text ?? "?"}` });
      return { ok: true, costUsd: 0 };
    },
  });
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
    body: JSON.stringify(body),
  });

describe("one message, one reply, end to end", () => {
  it("route → loop → model → reply verb → ledger → GET, with no debounce and no tab items", async () => {
    const seen: ProjectEvent[] = [];
    const off = subscribeProjectEvents((e) => seen.push(e));
    const r = await messagePOST(post({ projectId: P, text: "What is tab-1 doing?" }));
    expect(r.status).toBe(200);
    const { id } = (await r.json()) as { id: string };
    // Well inside the 5 s debounce a tab event would wait for.
    await vi.waitFor(() => expect(seen.some((e) => e.event === "supervisor.message" && e.data.from === "supervisor")).toBe(true), { timeout: 2_000 });
    off();

    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.map((i) => i.trigger)).toEqual(["message"]);
    const res = await messageGET(new NextRequest(`${BASE}/api/supervisor/message?projectId=${P}`, { headers: { "x-marvin-supervisor-token": token() } }));
    const got = (await res.json()) as { messages: Array<{ from: string; text: string; origin?: { messageIds: string[] } }> };
    expect(got.messages.map((m) => m.from)).toEqual(["user", "supervisor"]);
    expect(got.messages[1]).toMatchObject({ text: "Read you: What is tab-1 doing?", origin: { messageIds: [id] } });
    const wakeLines = readLedger(P).filter((e) => e.wakeId);
    expect(wakeLines.length).toBeGreaterThan(0);
    expect(wakeLines.every((e) => e.origin?.kind === "message" && JSON.stringify(e.origin.messageIds) === JSON.stringify([id]))).toBe(true);
  });
});
