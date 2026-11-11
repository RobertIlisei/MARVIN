import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addNotice,
  MAX_LIVE_NOTICES,
  MAX_NOTICE_CHARS,
  noticesPath,
  noticesReminder,
  readNotices,
  renderNoticesBlock,
  retireNotice,
} from "../src/notices";
import { turnReminders } from "../src/sdk-runner";

// ADR-0131 — the store is project-controlled input: validated at the read
// boundary, anything malformed / expired / over-long dropped.

let root: string;
const NOW = new Date("2026-11-11T10:00:00.000Z");
const iso = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString();
const entry = (over: Record<string, unknown> = {}) => ({
  id: "n-1",
  text: "the test machine is back at a new address",
  createdAt: iso(-1),
  expiresAt: iso(23),
  author: "user",
  ...over,
});
const putFile = (v: unknown) => {
  mkdirSync(path.join(root, ".marvin"), { recursive: true });
  writeFileSync(noticesPath(root), typeof v === "string" ? v : JSON.stringify(v));
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "marvin-notices-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readNotices drops what does not validate", () => {
  it("keeps a good entry and returns nothing for a missing or non-array file", () => {
    expect(readNotices(root, NOW)).toEqual([]);
    putFile("{not json");
    expect(readNotices(root, NOW)).toEqual([]);
    putFile({ id: "x" });
    expect(readNotices(root, NOW)).toEqual([]);
    putFile([entry()]);
    expect(readNotices(root, NOW)).toHaveLength(1);
  });

  it("drops an over-long text, an expired entry and a lifetime beyond seven days", () => {
    putFile([
      entry({ id: "long", text: "x".repeat(MAX_NOTICE_CHARS + 1) }),
      entry({ id: "old", expiresAt: iso(-0.5) }),
      entry({ id: "forever", createdAt: iso(-1), expiresAt: iso(24 * 8) }),
      entry({ id: "good" }),
    ]);
    expect(readNotices(root, NOW).map((n) => n.id)).toEqual(["good"]);
  });

  it("drops malformed entries: bad author, missing expiry, bad dates, bad id, empty text, non-objects", () => {
    putFile([
      entry({ id: "a", author: "tab" }),
      entry({ id: "b", expiresAt: undefined }),
      entry({ id: "c", expiresAt: "tomorrow" }),
      entry({ id: "../d" }),
      entry({ id: "e", text: "  \n " }),
      entry({ id: "f", text: 42 }),
      "string",
      null,
      entry({ id: "ok" }),
    ]);
    expect(readNotices(root, NOW).map((n) => n.id)).toEqual(["ok"]);
  });

  it("removes control characters from the text", () => {
    putFile([entry({ text: "line one\nline\u0000 two\u001b[31m" })]);
    expect(readNotices(root, NOW)[0]?.text).toBe("line one line two[31m");
  });

  it("keeps at most eight live entries, the newest", () => {
    putFile(Array.from({ length: 12 }, (_, i) => entry({ id: `n${i}`, createdAt: iso(-20 + i), expiresAt: iso(10 + i) })));
    const live = readNotices(root, NOW);
    expect(live).toHaveLength(MAX_LIVE_NOTICES);
    expect(live[live.length - 1]?.id).toBe("n11");
  });
});

describe("addNotice / retireNotice", () => {
  it("posts with a 24 h default expiry and the author, and retires by id", () => {
    const r = addNotice(root, { text: "hello", author: "supervisor" }, NOW);
    expect(r.ok && r.notice.expiresAt).toBe(iso(24));
    expect(readNotices(root, NOW)).toHaveLength(1);
    expect(retireNotice(root, r.ok ? r.notice.id : "", NOW)).toBe(true);
    expect(readNotices(root, NOW)).toEqual([]);
    expect(retireNotice(root, "nope", NOW)).toBe(false);
  });

  it("refuses empty or over-long text, a lifetime over seven days, and a ninth notice", () => {
    expect(addNotice(root, { text: " ", author: "user" }, NOW).ok).toBe(false);
    expect(addNotice(root, { text: "x".repeat(401), author: "user" }, NOW).ok).toBe(false);
    expect(addNotice(root, { text: "a", author: "user", ttlHours: 24 * 7 + 1 }, NOW).ok).toBe(false);
    expect(addNotice(root, { text: "a", author: "user", ttlHours: 0 }, NOW).ok).toBe(false);
    for (let i = 0; i < MAX_LIVE_NOTICES; i += 1) expect(addNotice(root, { text: `n${i}`, author: "user" }, NOW).ok).toBe(true);
    expect(addNotice(root, { text: "one more", author: "user" }, NOW).ok).toBe(false);
  });
});

describe("the reminder block", () => {
  it("is null with nothing live, and labelled as neither consent nor a change of scope", () => {
    expect(noticesReminder(root, NOW)).toBeNull();
    putFile([entry()]);
    const block = noticesReminder(root, NOW) ?? "";
    expect(block).toContain("Project notices");
    expect(block).toMatch(/neither the user's consent/);
    expect(block).toMatch(/change of your scope/);
    expect(block).toContain("the test machine is back at a new address");
    expect(renderNoticesBlock([])).toBeNull();
  });

  it("rides turnReminders for any session of the project, and not at all without notices", () => {
    expect(turnReminders({ mode: "agent", noticesContext: noticesReminder(root, NOW) }).join("\n")).not.toContain("Project notices");
    putFile([entry()]);
    // Two tabs (and a tab opened later) share the project root, so each turn's reminders carry it.
    for (const sessionContext of ["tab A", "tab B", "a tab opened afterwards"]) {
      const r = turnReminders({ mode: "agent", sessionContext, noticesContext: noticesReminder(root, NOW) });
      expect(r.join("\n")).toContain("the test machine is back at a new address");
      expect(r[r.length - 1]).toContain("Project notices");
    }
  });
});
