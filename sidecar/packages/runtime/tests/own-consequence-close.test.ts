import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before any import that reads the data dir: the session meta lives there.
process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-own-consequence-data-"));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addBacklogItem, listBacklog, updateBacklogItem } from "../src/backlog";
import { __resetOwnConsequenceBlocksForTests, settleOwnConsequences } from "../src/own-consequence-close";
import { readSessionMeta, upsertSessionMeta } from "../src/session-meta";
import {
  buildReconcilePrompt,
  ownChangeConsequences,
  type OwnConsequence,
  parseHandovers,
  partitionOwnConsequences,
} from "../src/workflow-guard";

// A tab parked an item about a file its own change touched (ADR-0121), cannot
// fix it, and is not the one who may: the supervisor took it. Before this
// change every scope-met close re-asked — five times on 2026-11-25 — because
// the only answers were "fix it", "keep, it is pre-existing" and "do not claim
// scope met". None of them says "this is someone else's".
const ITEM_ID = "after-the-refund-branch-merges-align-askrefundbody-refundnot";
const PROJECT = "proj";
const SESSION = "12d5b487-fe9f-47d8-8da6-88d8f3e0b083";
const SCOPE_MET = "Everything is committed.\n\n**Scope met:** the terms are drafted. Anything else, or should I stop?\n<!-- marvin:scope-met -->";
const HANDOVER = `Handed over: ${ITEM_ID} to the supervisor — it waits on the refund branch merging, which this tab may not do`;

let workDir: string;
let own: OwnConsequence[];
let itemId: string;

beforeEach(async () => {
  __resetOwnConsequenceBlocksForTests();
  workDir = await mkdtemp(join(tmpdir(), "marvin-own-consequence-"));
  await mkdir(join(workDir, ".marvin"), { recursive: true });
  upsertSessionMeta(PROJECT, SESSION, {
    workDir,
    tree: { mode: "shared" },
    posture: { model: "m", advisorModel: null, personality: "marvin", permissionStrategy: "full", thinkingMode: "high" },
  }, { ownConsequenceBlocks: {} });
  await addBacklogItem(workDir, {
    title: "After the refund branch merges: align askRefundBody wording",
    body: "Names docs/legal/terms-1.4-refund-clause-redline.md. Waits on the refund branch.",
    provisional: true,
    sessionId: SESSION,
  });
  const parked = (await listBacklog(workDir)).filter((i) => i.status === "provisional");
  itemId = parked[0]?.id ?? "";
  own = ownChangeConsequences(
    parked.map((i) => ({ id: i.id, title: i.title, body: i.body })),
    ["docs/legal/terms-1.4-refund-clause-redline.md"],
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const handover = (id: string) => HANDOVER.replace(ITEM_ID, id);
const settle = (finalText: string) =>
  settleOwnConsequences({ workDir, projectId: PROJECT, sessionId: SESSION, finalText, own, maxBlocks: 2 });
const itemNow = async () => (await listBacklog(workDir)).find((i) => i.id === itemId);

describe("parseHandovers", () => {
  it("reads `Handed over: <id> to <who> — <reason>` and nothing looser", () => {
    const m = parseHandovers(`${SCOPE_MET}\n\n${HANDOVER}\n- Handed over: other-item to tab feat-billing - it is theirs now`);
    expect(m.get(ITEM_ID)).toEqual({ who: "the supervisor", reason: "it waits on the refund branch merging, which this tab may not do" });
    expect(m.get("other-item")?.who).toBe("tab feat-billing");
    expect(parseHandovers("Handed over: some-id").size).toBe(0);
    expect(parseHandovers(`Handed over: ${ITEM_ID} to — no one named`).size).toBe(0);
    expect(parseHandovers(`Handed over: ${ITEM_ID} to nobody`).size).toBe(0);
  });
});

describe("partitionOwnConsequences", () => {
  it("asks about an item the tab did not answer, hands over one it did, and does not let one answer excuse another", () => {
    const other: OwnConsequence = { id: "second-item", title: "second", because: "x.ts" };
    const text = `${SCOPE_MET}\n${handover(ITEM_ID)}`;
    const p = partitionOwnConsequences([{ id: ITEM_ID, title: "t", because: "b" }, other], text, {}, 2);
    expect(p.handedOver.map((h) => h.id)).toEqual([ITEM_ID]);
    expect(p.ask.map((a) => a.id)).toEqual(["second-item"]);
    expect(p.bypassed).toEqual([]);
  });

  it("lets an item through after it has refused two closes, and says it was bypassed", () => {
    expect(partitionOwnConsequences(own, SCOPE_MET, { [itemId]: 1 }, 2).ask.map((a) => a.id)).toEqual([itemId]);
    const p = partitionOwnConsequences(own, SCOPE_MET, { [itemId]: 2 }, 2);
    expect(p.ask).toEqual([]);
    expect(p.bypassed.map((b) => b.id)).toEqual([itemId]);
  });
});

describe("the refusal text", () => {
  it("tells the tab the one line it may write, and the brake", () => {
    const { prompt } = buildReconcilePrompt({ openTodos: [], untickedAdrs: [], ownConsequences: own });
    expect(prompt).toContain("Handed over: <item-id> to <who> — <reason>");
    expect(prompt).toContain("stays provisional");
    expect(prompt).toContain("After 2 refusals");
    // The existing answers are still offered.
    expect(prompt).toContain("backlog_resolve … keep");
    expect(prompt).toContain("fix it now");
    expect(prompt).toContain("do NOT claim scope met");
  });
});

describe("settleOwnConsequences", () => {
  it("reproduces the loop without a hand-over: asked twice, then the close is allowed and the bypass is noted on the item", async () => {
    expect(itemId).not.toBe("");
    expect((await settle(SCOPE_MET)).map((a) => a.id)).toEqual([itemId]);
    expect((await settle(SCOPE_MET)).map((a) => a.id)).toEqual([itemId]);
    expect(readSessionMeta(PROJECT, SESSION)?.ownConsequenceBlocks).toEqual({ [itemId]: 2 });
    expect(await settle(SCOPE_MET)).toEqual([]);
    const item = await itemNow();
    expect(item?.status).toBe("provisional");
    expect(item?.body).toMatch(/> note \d{4}-\d{2}-\d{2} — close allowed after 2 refusals/);
  });

  it("the brake survives a restart (it is counted on the session meta, not in memory)", async () => {
    await settle(SCOPE_MET);
    await settle(SCOPE_MET);
    __resetOwnConsequenceBlocksForTests();
    expect(await settle(SCOPE_MET)).toEqual([]);
  });

  it("a hand-over ends the asking at the first close: a dated note, still provisional, neither kept nor dismissed", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await settle(`${SCOPE_MET}\n\n${handover(itemId)}`)).toEqual([]);
      const item = await itemNow();
      expect(item?.status).toBe("provisional");
      expect(item?.body).toMatch(/> note \d{4}-\d{2}-\d{2} — handed over to the supervisor: it waits on the refund branch merging/);
      expect(info.mock.calls.map((c) => String(c[0])).join("\n")).toContain("own.consequence.handover");
      // It was not counted as a refusal.
      expect(readSessionMeta(PROJECT, SESSION)?.ownConsequenceBlocks ?? {}).toEqual({});
    } finally {
      info.mockRestore();
    }
  });

  it("an item the tab can resolve is still asked about at the close", async () => {
    expect((await settle(`${SCOPE_MET}\n\nHanded over: some-other-item to a tab — not this one`)).map((a) => a.id)).toEqual([itemId]);
    expect((await itemNow())?.body).not.toContain("handed over");
  });

  it("a hand-over naming an item that is not in the gap writes nothing", async () => {
    await settle(`${SCOPE_MET}\n\nHanded over: nonexistent-item to the supervisor — whatever`);
    expect((await itemNow())?.body).not.toContain("handed over");
  });

  it("works in a machine turn with no human: the same text from a wakeup closes the question", async () => {
    // The corrective turn is a wakeup; its final message carries the line.
    expect(await settle(`Reconciled.\n${handover(itemId)}\n${SCOPE_MET}`)).toEqual([]);
  });

  it("a note the item cannot take leaves the question open, never a silent pass", async () => {
    expect((await updateBacklogItem(workDir, itemId, { note: "y".repeat(3950) })).ok).toBe(true);
    expect((await settle(`${SCOPE_MET}\n\n${handover(itemId)}`)).map((a) => a.id)).toEqual([itemId]);
    expect((await itemNow())?.body).not.toContain("handed over");
  });
});
