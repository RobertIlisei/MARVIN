// ADR-0113 §3 — when a tab resolves an item, the other open tabs that touch
// the same files hear about it: injected where a turn is live, queued
// otherwise, skipped when their branch touches none of the item's paths.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BacklogItem } from "../src/backlog";
import { MAX_NOTICES_PER_RESOLUTION, notifyTabsOfResolution, resolutionNoticeText } from "../src/backlog-notify";

const item = (over: Partial<BacklogItem> & { title: string }): BacklogItem => ({
  id: "x", body: "", status: "done", severity: "med", kind: "bug", blocked: false, blockedOn: "",
  sessionId: "", claimedBy: "", claimedBranch: "", claimedAt: "", created: "", updated: "", ...over,
});

describe("resolutionNoticeText", () => {
  it("names the sender tab, the item, its paths, and says it is not the user's word", () => {
    const t = resolutionNoticeText({ item: item({ id: "fix-lock", title: "Fix the lock", status: "done" }), fromBranch: "marvin/tab/fix-lock", paths: ["apps/api/Job.java"] });
    expect(t).toContain("[notice from tab fix-lock]");
    expect(t).toContain("`fix-lock`");
    expect(t).toContain("marked done");
    expect(t).toContain("apps/api/Job.java");
    expect(t).toMatch(/not an instruction from the user/);
    expect(resolutionNoticeText({ item: item({ title: "x" }), paths: [] })).toContain("[notice from another tab]");
  });
});

describe("notifyTabsOfResolution", () => {
  let repo: string;
  let git: (...a: string[]) => string;
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-notify-")));
    git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8", stdio: "pipe" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const branchWith = (name: string, file: string) => {
    const base = git("rev-parse", "HEAD");
    git("checkout", "-q", "-b", name);
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), "x\n");
    git("add", file);
    git("commit", "-qm", `touch ${file}`);
    git("checkout", "-q", "main");
    return { branch: name, base };
  };

  it("injects into a live tab, queues for an idle one, skips a tab whose branch touches none of the item's paths, never the sender", () => {
    const a = branchWith("marvin/tab/a", "apps/api/Job.java");
    const b = branchWith("marvin/tab/b", "docs/other.md");
    const injected: string[] = [];
    const queued: string[] = [];
    const out = notifyTabsOfResolution({
      projectId: "p",
      workDir: repo,
      fromSessionId: "sender",
      fromBranch: "marvin/tab/sender",
      item: item({ id: "fix-job", title: "Fix apps/api/Job.java lock", body: "see apps/api/Job.java" }),
      deps: {
        listOpenSessions: () => [
          { marvinSessionId: "sender", branch: "marvin/tab/sender", base: a.base },
          { marvinSessionId: "live-a", branch: a.branch, base: a.base },
          { marvinSessionId: "idle-a", branch: a.branch, base: a.base },
          { marvinSessionId: "tab-b", branch: b.branch, base: b.base },
          { marvinSessionId: "shared" },
        ],
        inject: (sid, text) => { if (sid === "live-a") { injected.push(text); return true; } return false; },
        enqueue: (sid, text) => { queued.push(`${sid}:${text.slice(0, 20)}`); return true; },
      },
    });
    expect(out.map((n) => [n.toSessionId, n.delivered])).toEqual([
      ["live-a", "injected"],
      ["idle-a", "queued"],
      ["tab-b", "skipped"],
      ["shared", "queued"],
    ]);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("[notice from tab sender]");
  });

  it("an item naming no path reaches every open tab, bounded", () => {
    const sessions = Array.from({ length: MAX_NOTICES_PER_RESOLUTION + 3 }, (_, i) => ({ marvinSessionId: `s${i}` }));
    const out = notifyTabsOfResolution({
      projectId: "p", workDir: repo, fromSessionId: "nobody",
      item: item({ id: "general", title: "Tidy the thing", body: "no paths here" }),
      deps: { listOpenSessions: () => sessions, inject: () => false, enqueue: () => true },
    });
    expect(out).toHaveLength(MAX_NOTICES_PER_RESOLUTION);
    expect(out.every((n) => n.delivered === "queued")).toBe(true);
  });
});
