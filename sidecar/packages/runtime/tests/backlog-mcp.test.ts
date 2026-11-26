import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The SDK's `tool` / `createSdkMcpServer` are replaced by recorders so the
// handlers can be called directly: what is under test is what the model is
// told and what the boundary accepts.
// (`vi.doMock` + a fresh module registry rather than a hoisted `vi.mock`: the
// suite runs with `isolate: false`, so another file may already have loaded the
// real server module.)
const sdkMock = () => ({
  tool: (name: string, description: string, schema: unknown, handler: (args: Record<string, unknown>) => Promise<unknown>) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: { tools: unknown[] }) => o,
});

type BacklogModule = typeof import("../src/backlog");
type DeriveModule = typeof import("../src/backlog-derive");
type McpModule = typeof import("../src/backlog-mcp");
let getBacklogItem: BacklogModule["getBacklogItem"];
let resolveBacklogItem: BacklogModule["resolveBacklogItem"];
let resetBacklogDeriveForTests: DeriveModule["resetBacklogDeriveForTests"];
let createBacklogMcpServer: McpModule["createBacklogMcpServer"];

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("@anthropic-ai/claude-agent-sdk", sdkMock);
  ({ getBacklogItem, resolveBacklogItem } = await import("../src/backlog"));
  ({ resetBacklogDeriveForTests } = await import("../src/backlog-derive"));
  ({ createBacklogMcpServer } = await import("../src/backlog-mcp"));
});
afterAll(() => {
  vi.doUnmock("@anthropic-ai/claude-agent-sdk");
  vi.resetModules();
});

interface Tool {
  name: string;
  description: string;
  handler: (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
}

let workDir: string;
let tools: Record<string, Tool>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-backlog-mcp-"));
  resetBacklogDeriveForTests();
  const server = createBacklogMcpServer({ cwd: workDir, marvinSessionId: "sess-1" }) as unknown as { tools: Tool[] };
  tools = Object.fromEntries(server.tools.map((t) => [t.name, t]));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join("\n");

describe("what the tools tell a tab", () => {
  it("backlog_add names the commit trailer and relatesTo; backlog_update names the cap advice; resolve names the trailer", () => {
    expect(tools.backlog_add?.description).toContain("Fixes-Backlog: <slug>");
    expect(tools.backlog_add?.description).toContain("closes nothing");
    expect(tools.backlog_add?.description).toContain("relatesTo");
    expect(tools.backlog_update?.description).toContain("relatesTo");
    expect(tools.backlog_resolve?.description).toContain("Fixes-Backlog: <slug>");
    expect(tools.backlog_list?.description).toContain("closed index");
  });
});

describe("priority and the new fields at the tool boundary", () => {
  it("backlog_add accepts low | medium | high and the optional fields", async () => {
    const r = await tools.backlog_add!.handler({ title: "Add with every field", priority: "high", type: "debt", release: "v3.2", origin: "review-x", waitsOn: "owner" });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("(high)");
    expect(await getBacklogItem(workDir, "add-with-every-field")).toMatchObject({ severity: "high", kind: "chore", blocked: true, blockedOn: "owner", release: "v3.2", origin: "review-x" });
    const listed = text(await tools.backlog_list!.handler({}));
    expect(listed).toContain("v3.2 · waits on owner");
  });

  it("`severity` is the field and `priority` its alias: both held to low | medium | high", async () => {
    expect((await tools.backlog_add!.handler({ title: "Severity ok", severity: "low" })).isError).toBeUndefined();
    expect((await tools.backlog_add!.handler({ title: "Severity bad", severity: "med" })).isError).toBe(true);
  });

  it("backlog_add refuses `med` and other values, clearly, and writes nothing", async () => {
    const r = await tools.backlog_add!.handler({ title: "Wrong spelling", priority: "med" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("low, medium, high");
    expect(text(r)).toContain('did you mean "medium"');
    expect(text(await tools.backlog_list!.handler({}))).toContain("No open backlog items");
  });

  it("backlog_update refuses a bad priority and accepts the new fields", async () => {
    await tools.backlog_add!.handler({ title: "Update me" });
    const bad = await tools.backlog_update!.handler({ id: "update-me", priority: "hi" });
    expect(bad.isError).toBe(true);
    const ok = await tools.backlog_update!.handler({ id: "update-me", priority: "high", release: "v4", waitsOn: "reviewer" });
    expect(text(ok)).toContain("severity=high");
    expect(text(ok)).toContain("release=v4");
  });

  it("relatesTo is accepted on add and checked", async () => {
    await tools.backlog_add!.handler({ title: "The long running one" });
    expect((await tools.backlog_add!.handler({ title: "Its follow up", relatesTo: "the-long-running-one" })).isError).toBeUndefined();
    const bad = await tools.backlog_add!.handler({ title: "A dangling follow up", relatesTo: "nothing-like-it" });
    expect(bad.isError).toBe(true);
  });
});

describe("backlog_list reads the open items, and the archive only when asked", () => {
  it("defaults to open items; status done / dismissed / all read the archive, paged", async () => {
    const names = ["alpha", "bravo", "charlie", "delta", "echo"];
    for (const n of names) await tools.backlog_add!.handler({ title: `Archived ${n}` });
    await tools.backlog_add!.handler({ title: "Still open" });
    for (const [i, n] of names.entries()) await resolveBacklogItem(workDir, { id: `archived-${n}`, resolution: i % 2 ? "dismissed" : "done" });

    const open = text(await tools.backlog_list!.handler({}));
    expect(open).toContain("Backlog (1):");
    expect(open).toContain("Still open");
    expect(open).not.toContain("Archived item");

    const page = text(await tools.backlog_list!.handler({ status: "all", limit: 2 }));
    expect(page).toContain("Closed (1–2 of 5):");
    expect(page).toContain("offset 2");
    const next = text(await tools.backlog_list!.handler({ status: "all", limit: 2, offset: 2 }));
    expect(next).toContain("Closed (3–4 of 5):");
    const done = text(await tools.backlog_list!.handler({ status: "done" }));
    expect(done).toContain("of 3):");
    expect(text(await tools.backlog_list!.handler({ status: "dismissed" }))).toContain("of 2):");
  });
});
