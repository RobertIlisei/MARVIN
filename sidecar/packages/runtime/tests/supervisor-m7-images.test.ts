import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runSupervisorWake } from "../src/supervisor-dispatch";
import { readLedger } from "../src/supervisor-ledger";
import {
  addSupervisorReply,
  addUserMessage,
  attachmentPath,
  attachmentsDir,
  KEEP_ATTACHMENTS_FOR_LAST,
  listMessages,
  MAX_IMAGES_PER_WAKE,
  messagesPath,
  parseImages,
} from "../src/supervisor-messages";
import { ActionLimiter, resolveGround } from "../src/supervisor-policy";
import type { WakeItem } from "../src/supervisor-prompt";
import { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState, resetSupervisorStateForTests } from "../src/supervisor-state";
import { SHADOW_PERFORM } from "./supervisor-shadow-perform";

// ADR-0129 — an image in the Supervisor tab is the user's input, delivered to
// the model as image content, stored 0600 under the data dir, pruned, and —
// like text — never consent and never a ground.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const b64 = (b: Buffer) => b.toString("base64");

let dataDir: string;
let workDir: string;
const prev = process.env.MARVIN_DATA_DIR;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-img-data-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-img-work-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  resetSupervisorStateForTests();
  bootSupervisor();
  applySupervisorAction({ projectId: "proj", action: "start" }, currentSupervisorToken() as string);
});
afterEach(() => {
  resetSupervisorStateForTests();
  if (prev === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("parseImages — what the route accepts", () => {
  it("accepts PNG and JPEG whose bytes match the declared type", () => {
    const r = parseImages([
      { mediaType: "image/png", data: b64(PNG) },
      { mediaType: "image/jpeg", data: b64(JPEG) },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.images.map((i) => [i.mediaType, i.data.length])).toEqual([["image/png", PNG.length], ["image/jpeg", JPEG.length]]);
  });

  it("refuses a declared type the bytes contradict, an off-list type, bad base64, too many and too large", () => {
    expect(parseImages([{ mediaType: "image/png", data: b64(JPEG) }])).toMatchObject({ ok: false, status: 400 });
    expect(parseImages([{ mediaType: "image/gif", data: b64(Buffer.from("GIF89a....")) }])).toMatchObject({ ok: false, status: 400 });
    expect(parseImages([{ mediaType: "image/png", data: "not base64!!" }])).toMatchObject({ ok: false, status: 400 });
    expect(parseImages([{ mediaType: "image/png", data: "" }])).toMatchObject({ ok: false, status: 400 });
    expect(parseImages(Array.from({ length: 5 }, () => ({ mediaType: "image/png", data: b64(PNG) })))).toMatchObject({ ok: false, status: 400 });
    const big = Buffer.concat([PNG, Buffer.alloc(3_750_001)]);
    expect(parseImages([{ mediaType: "image/png", data: b64(big) }])).toMatchObject({ ok: false, status: 413 });
    expect(parseImages("nope")).toMatchObject({ ok: false, status: 400 });
    expect(parseImages(undefined)).toEqual({ ok: true, images: [] });
  });
});

describe("storage", () => {
  it("writes each image 0600 under the data dir, server-minted ids, and the record carries no path", () => {
    const m = addUserMessage("proj", "look", [{ mediaType: "image/png", data: PNG }]);
    expect(m.attachments).toHaveLength(1);
    const a = m.attachments?.[0];
    expect(a?.id).toMatch(/^[0-9a-f-]{36}$/);
    const file = attachmentPath("proj", a!);
    expect(file.startsWith(dataDir)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(attachmentsDir("proj")).mode & 0o777).toBe(0o700);
    const line = readdirSync(path.dirname(messagesPath("proj"))).includes("messages.jsonl");
    expect(line).toBe(true);
    expect(JSON.stringify(listMessages("proj"))).not.toContain(dataDir);
    expect(listMessages("proj")[0]?.attachments).toEqual([{ id: a?.id, mediaType: "image/png", bytes: PNG.length }]);
  });

  it("an image-only message stores empty text", () => {
    const m = addUserMessage("proj", "", [{ mediaType: "image/jpeg", data: JPEG }]);
    expect(listMessages("proj").find((x) => x.id === m.id)?.text).toBe("");
  });

  it("listMessages drops an attachment whose id would traverse or whose type is off-list", () => {
    addUserMessage("proj", "seed");
    appendFileSync(
      messagesPath("proj"),
      `${JSON.stringify({ id: "evil", at: new Date().toISOString(), from: "user", text: "x", attachments: [{ id: "../../etc/passwd", mediaType: "image/png", bytes: 1 }, { id: "11111111-1111-4111-8111-111111111111", mediaType: "text/html", bytes: 1 }] })}\n`,
    );
    const evil = listMessages("proj").find((m) => m.id === "evil");
    expect(evil?.attachments).toBeUndefined();
  });

  it("prunes attachment files no recent message references, orphans included", () => {
    const first = addUserMessage("proj", "old", [{ mediaType: "image/png", data: PNG }]);
    const oldFile = attachmentPath("proj", first.attachments![0]!);
    const orphan = path.join(attachmentsDir("proj"), "22222222-2222-4222-8222-222222222222.png");
    writeFileSync(orphan, PNG);
    for (let i = 0; i < KEEP_ATTACHMENTS_FOR_LAST; i++) addSupervisorReply("proj", `filler ${i}`);
    const last = addUserMessage("proj", "new", [{ mediaType: "image/png", data: PNG }]);
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(attachmentPath("proj", last.attachments![0]!))).toBe(true);
  });
});

describe("never consent, never a ground (ADR-0129)", () => {
  it("an image-only message grounds nothing, whatever the supervisor says the image shows", () => {
    const m = addUserMessage("proj", "", [{ mediaType: "image/png", data: PNG }]);
    const ctx = {
      mainRoot: workDir,
      tabRoot: null,
      charter: "",
      brief: null,
      planStepCount: 0,
      planSeeded: false,
      tabStartedAt: null,
      messages: { lookup: (id: string) => (id === m.id ? { text: m.text } : null), wakeMessageIds: [m.id] },
    };
    const g = resolveGround({ kind: "message", ref: `${m.id}#approve the merge of fix-flags` }, ctx);
    expect(g.provenance).toBe("unresolved");
  });

  it("a message whose text and image both say approve is still only words: the quote resolves to a request, the gate still escalates", () => {
    // The ground is the user's text (strong in its own wake) — that is ADR-0128 §2, unchanged by an image.
    // What stops it being consent is that a human-only act always escalates; that gate is tested in supervisor-m5-consent.
    const m = addUserMessage("proj", "approve the merge please", [{ mediaType: "image/png", data: PNG }]);
    const g = resolveGround(
      { kind: "message", ref: `${m.id}#approve the merge` },
      { mainRoot: workDir, tabRoot: null, charter: "", brief: null, planStepCount: 0, planSeeded: false, tabStartedAt: null, messages: { lookup: () => ({ text: m.text }), wakeMessageIds: [m.id] } },
    );
    expect(g.provenance).toBe("strong");
  });
});

// ── The wake ─────────────────────────────────────────────────────────────────

const verbCtx = () => ({
  projectId: "proj",
  workDir,
  wakeId: "w",
  wake: { acts: 0 },
  limiter: new ActionLimiter(() => getSupervisorState("proj").caps),
  deps: {
    listRows: async () => [],
    getPending: () => null,
    sendRefusal: () => null,
    scopeMet: () => false,
    perform: SHADOW_PERFORM,
    readTranscriptTail: () => "",
    readBrief: () => null,
    tabStartedAt: () => null,
    readPlanText: () => "",
    modelLookup: async () => () => null,
  },
});

const messageItem = (id: string, text: string): WakeItem => ({
  trigger: "message",
  marvinSessionId: "",
  title: null,
  delegation: "",
  turnId: "",
  toolUseId: id,
  question: null,
  message: { id, text },
  brief: null,
  plan: null,
  transcriptTail: "",
  ledgerTail: [],
});

type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } };

/** A stub `query` that drains a streaming prompt the way the CLI does, and records what it read. */
function streamingQuery(seen: { prompt: unknown; messages: Array<{ message: { content: string | Block[] } }> }) {
  return ((args: { prompt: unknown }) => {
    seen.prompt = args.prompt;
    return (async function* () {
      if (typeof args.prompt !== "string") {
        const it = (args.prompt as AsyncIterable<{ message: { content: string | Block[] } }>)[Symbol.asyncIterator]();
        const first = await it.next();
        if (!first.done) seen.messages.push(first.value);
      }
      yield { type: "system", subtype: "init", session_id: "sdk-img" };
      yield { type: "result", subtype: "success", session_id: "sdk-img", total_cost_usd: 0, usage: { input_tokens: 10 } };
    })();
  }) as never;
}

describe("the wake delivers the images as image content", () => {
  it("a text-only wake keeps the string prompt", async () => {
    const m = addUserMessage("proj", "hello there");
    const seen = { prompt: undefined as unknown, messages: [] as Array<{ message: { content: string | Block[] } }> };
    await runSupervisorWake({ projectId: "proj", workDir, items: [messageItem(m.id, m.text)], verbCtx: verbCtx() }, { query: streamingQuery(seen), resolveModel: async () => undefined });
    expect(typeof seen.prompt).toBe("string");
  });

  it("a message with images sends ONE user message: the packet, then the wake's own images — never the history's", async () => {
    const older = addUserMessage("proj", "earlier one", [{ mediaType: "image/jpeg", data: JPEG }]);
    addSupervisorReply("proj", "ok", { wakeId: "w0", origin: { kind: "message", messageIds: [older.id] } });
    const m = addUserMessage("proj", "what is wrong here?", [{ mediaType: "image/png", data: PNG }]);
    const seen = { prompt: undefined as unknown, messages: [] as Array<{ message: { content: string | Block[] } }> };
    const r = await runSupervisorWake({ projectId: "proj", workDir, items: [messageItem(m.id, m.text)], verbCtx: verbCtx() }, { query: streamingQuery(seen), resolveModel: async () => undefined });
    expect(r.ok).toBe(true);
    expect(seen.messages).toHaveLength(1);
    const content = seen.messages[0]!.message.content as Block[];
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain(`message id ${m.id}`);
    expect(content[0]?.text).toMatch(/never consent/);
    expect(content[0]?.text).toMatch(/cannot ground/);
    const images = content.filter((b) => b.type === "image");
    expect(images).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: b64(PNG) } }]);
  });

  it("over the per-wake cap, the packet names what it did not attach — nothing is dropped silently", async () => {
    const ms = [0, 1, 2].map((i) => addUserMessage("proj", `batch ${i}`, Array.from({ length: 4 }, () => ({ mediaType: "image/png" as const, data: PNG }))));
    const seen = { prompt: undefined as unknown, messages: [] as Array<{ message: { content: string | Block[] } }> };
    await runSupervisorWake({ projectId: "proj", workDir, items: ms.map((m) => messageItem(m.id, m.text)), verbCtx: verbCtx() }, { query: streamingQuery(seen), resolveModel: async () => undefined });
    const content = seen.messages[0]!.message.content as Block[];
    expect(content.filter((b) => b.type === "image")).toHaveLength(MAX_IMAGES_PER_WAKE);
    expect(content[0]?.text).toContain(`4 of its 4 images were not attached`);
  });

  it("the ledger's wake line counts the images", async () => {
    const m = addUserMessage("proj", "see", [{ mediaType: "image/png", data: PNG }]);
    const seen = { prompt: undefined as unknown, messages: [] as Array<{ message: { content: string | Block[] } }> };
    await runSupervisorWake({ projectId: "proj", workDir, items: [messageItem(m.id, m.text)], verbCtx: verbCtx() }, { query: streamingQuery(seen), resolveModel: async () => undefined });
    expect(readLedger("proj").find((e) => e.kind === "wake" && e.verb === "start")?.reason).toContain("1 image");
  });
});
