// ADR-0107 — per-session meta beside the transcript. Pins the store's
// contract the same way plan-state.test.ts does: identity hygiene, atomic
// round-trip, corrupt file reads as "nothing stored", create-or-merge
// semantics, cwd resolution for both tree modes, and lane normalisation.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  listSessionMetas,
  normaliseLane,
  readSessionMeta,
  resolveSessionCwd,
  type SessionMeta,
  sessionMetaPath,
  updateSessionMeta,
  upsertSessionMeta,
  writeSessionMeta,
} from "../src/session-meta";

let dataDir: string;
let workDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "marvin-session-meta-"));
  workDir = mkdtempSync(path.join(tmpdir(), "marvin-session-meta-proj-"));
  process.env.MARVIN_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.MARVIN_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const posture = {
  model: "claude-sonnet-5",
  advisorModel: null,
  personality: "ultron" as const,
  permissionStrategy: "auto" as const,
  thinkingMode: "high",
};

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    version: 1,
    marvinSessionId: id,
    projectId: "proj",
    workDir,
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    tree: { mode: "shared" },
    posture,
    ...extra,
  };
}

describe("session meta — store contract", () => {
  it("round-trips a record beside the transcript", () => {
    const m = meta("s1");
    expect(writeSessionMeta(m)).toEqual({ ok: true });
    expect(sessionMetaPath("proj", "s1")).toBe(path.join(dataDir, "sessions", "proj", "s1.meta.json"));
    expect(readSessionMeta("proj", "s1")).toEqual(m);
    // No torn temp file left behind.
    expect(() => readFileSync(`${sessionMetaPath("proj", "s1")}.tmp`)).toThrow();
  });

  it("rejects ids that could escape the sessions directory", () => {
    expect(writeSessionMeta(meta("../evil")).ok).toBe(false);
    expect(writeSessionMeta(meta("a/b")).ok).toBe(false);
    expect(readSessionMeta("proj", "../evil")).toBeNull();
  });

  it("a corrupt file reads as nothing stored", () => {
    mkdirSync(path.dirname(sessionMetaPath("proj", "bad")), { recursive: true });
    writeFileSync(sessionMetaPath("proj", "bad"), "{not json", "utf8");
    expect(readSessionMeta("proj", "bad")).toBeNull();
    writeFileSync(sessionMetaPath("proj", "old"), JSON.stringify({ version: 0 }), "utf8");
    expect(readSessionMeta("proj", "old")).toBeNull();
  });

  it("upsert creates from the seed, then merges patches over the record", () => {
    const created = upsertSessionMeta("proj", "s2", { workDir, tree: { mode: "shared" }, posture });
    expect(created?.tree).toEqual({ mode: "shared" });
    expect(created?.createdAt).toBe(created?.updatedAt);
    const patched = upsertSessionMeta(
      "proj",
      "s2",
      { workDir: "/elsewhere", tree: { mode: "shared", lane: ["x"] }, posture },
      { title: "Renamed", lastTurn: { turnId: "t1", startedAt: "2026-09-09T01:00:00.000Z" } },
    );
    // Seed is ignored once the record exists; only the patch lands.
    expect(patched?.workDir).toBe(workDir);
    expect(patched?.tree).toEqual({ mode: "shared" });
    expect(patched?.title).toBe("Renamed");
    expect(patched?.lastTurn?.turnId).toBe("t1");
    expect(patched?.createdAt).toBe(created?.createdAt);
  });

  it("update patches an existing record and leaves a missing one missing", () => {
    expect(updateSessionMeta("proj", "nope", { title: "x" })).toBeNull();
    const m = updateSessionMeta("proj", "s2", { closedAt: "2026-09-09T02:00:00.000Z" });
    expect(m?.closedAt).toBe("2026-09-09T02:00:00.000Z");
    expect(m?.title).toBe("Renamed");
  });

  it("lists every meta of a project and nothing else", () => {
    const ids = listSessionMetas("proj").map((m) => m.marvinSessionId).sort();
    expect(ids).toEqual(["s1", "s2"]);
    expect(listSessionMetas("other")).toEqual([]);
  });
});

describe("resolveSessionCwd", () => {
  it("shared → the project root", () => {
    expect(resolveSessionCwd(meta("a"))).toEqual({ cwd: workDir, present: true });
  });
  it("worktree → the worktree path, present only when it is on disk", () => {
    const wt = path.join(workDir, ".marvin", "worktrees", "tab-x");
    const m = meta("b", { tree: { mode: "worktree", slug: "x", path: wt, branch: "marvin/tab/x", base: "abc" } });
    expect(resolveSessionCwd(m)).toEqual({ cwd: wt, present: false });
    mkdirSync(wt, { recursive: true });
    expect(resolveSessionCwd(m).present).toBe(true);
  });
});

describe("normaliseLane", () => {
  it("normalises, dedupes and caps", () => {
    expect(normaliseLane(["src/api/", "src/api", "./docs", "docs\\guides"])).toEqual(["src/api", "docs", "docs/guides"]);
    expect(normaliseLane(Array.from({ length: 40 }, (_, i) => `p${i}`))?.length).toBe(32);
  });
  it("rejects absolute and escaping entries", () => {
    expect(normaliseLane(["/etc"])).toBeNull();
    expect(normaliseLane(["../x"])).toBeNull();
    expect(normaliseLane(["a/../../b"])).toBeNull();
  });
  it("the root lane is '.'", () => {
    expect(normaliseLane(["."])).toEqual(["."]);
    expect(normaliseLane("nope")).toBeNull();
    expect(normaliseLane([42, "  "])).toEqual([]);
  });
});
