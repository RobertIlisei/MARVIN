import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AMBIGUITY_THRESHOLD,
  buildCallIndex,
  callersOf,
  symbolOf,
} from "../src/call-index";

// The point of this module is that graph.json CANNOT answer "who calls X" —
// it is built undirected, so edge orientation is networkx iteration order
// rather than semantics. These tests pin the properties that make the
// cache-derived answer trustworthy instead: exact caller sites, stale entries
// dropped, and loud honesty when a symbol name is too common to mean anything.

let workDir: string;
let cacheDir: string;
let srcDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-callidx-"));
  cacheDir = join(workDir, "graphify-out", "cache");
  srcDir = join(workDir, "src");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Write a real source file so its call sites survive the staleness filter. */
async function realFile(name: string): Promise<string> {
  const p = join(srcDir, name);
  await writeFile(p, "// source\n", "utf-8");
  return p;
}

async function cacheEntry(
  name: string,
  rawCalls: Array<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    join(cacheDir, name),
    JSON.stringify({ nodes: [], edges: [], raw_calls: rawCalls }),
    "utf-8",
  );
}

const call = (callerNid: string, callee: string, file: string, loc: string) => ({
  caller_nid: callerNid,
  callee,
  source_file: file,
  source_location: loc,
});

describe("symbolOf", () => {
  it("round-trips a graphify label to the name the callee side uses", () => {
    expect(symbolOf("startScheduledTurn()")).toBe("startScheduledTurn");
    expect(symbolOf("  buildProjectContext  ")).toBe("buildProjectContext");
    expect(symbolOf("ChatPreviewModel")).toBe("ChatPreviewModel");
  });
});

describe("buildCallIndex", () => {
  it("returns an empty index when there is no cache at all", () => {
    const idx = buildCallIndex(join(workDir, "nowhere"));
    expect(idx.files).toBe(0);
    expect(idx.edges).toBe(0);
  });

  it("indexes call edges by callee name", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [
      call("route_post", "buildProjectContext", f, "L196"),
      call("orchestrator_start", "buildProjectContext", f, "L190"),
    ]);
    const idx = buildCallIndex(workDir);
    expect(idx.edges).toBe(2);
    expect(idx.byCallee.get("buildProjectContext")).toHaveLength(2);
  });

  it("DROPS call sites whose source file no longer exists", async () => {
    // The cache is content-addressed and never garbage-collected, so it keeps
    // entries from previous repo layouts. This repo's real cache still held
    // `apps/web/.../route.ts` sites long after that tree became `sidecar/`.
    // Reporting them would send MARVIN to read a file that isn't there.
    const alive = await realFile("alive.ts");
    await cacheEntry("a.json", [
      call("live_caller", "target", alive, "L1"),
      call("ghost_caller", "target", join(srcDir, "deleted.ts"), "L2"),
    ]);
    const idx = buildCallIndex(workDir);
    expect(idx.edges).toBe(1);
    expect(idx.stale).toBe(1);
    expect(idx.byCallee.get("target")?.[0]?.callerNid).toBe("live_caller");
  });

  it("survives a truncated cache entry instead of losing the whole index", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("good.json", [call("c", "target", f, "L1")]);
    await writeFile(join(cacheDir, "broken.json"), "{ truncated", "utf-8");
    const idx = buildCallIndex(workDir);
    expect(idx.byCallee.get("target")).toHaveLength(1);
  });

  it("ignores entries missing the fields that make a call site usable", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [
      { caller_nid: "c", source_file: f }, // no callee
      { callee: "target", source_file: f }, // no caller
      call("c", "target", f, "L9"), // the only usable one
    ]);
    expect(buildCallIndex(workDir).edges).toBe(1);
  });

  it("re-reads when the cache changes rather than serving a stale memo", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [call("c1", "target", f, "L1")]);
    expect(buildCallIndex(workDir).edges).toBe(1);
    await cacheEntry("b.json", [call("c2", "target", f, "L2")]);
    expect(buildCallIndex(workDir).edges).toBe(2);
  });

  it("folds in ONLY new cache entries — no duplicates from re-reading old ones", async () => {
    // The incremental path is what makes this affordable on a large project:
    // a full parse of a real Spring Boot cache is ~321 MB of I/O, and MARVIN's
    // watchdog runs `graphify update` every turn. If an incremental pass
    // re-ingested an already-seen file, every call site would double per turn.
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [call("c1", "target", f, "L1")]);
    buildCallIndex(workDir);
    await cacheEntry("b.json", [call("c2", "target", f, "L2")]);
    const idx = buildCallIndex(workDir);
    expect(idx.edges).toBe(2);
    expect(idx.byCallee.get("target")).toHaveLength(2);
    expect(idx.files).toBe(2);
  });

  it("rebuilds from scratch when a cache entry DISAPPEARS", async () => {
    // Content-addressed entries only ever appear, so a vanished one means the
    // cache was pruned or rebuilt — and the accumulated index may hold call
    // sites that no longer exist. That is the one case incremental cannot fix.
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [call("c1", "gone", f, "L1")]);
    await cacheEntry("b.json", [call("c2", "kept", f, "L2")]);
    expect(buildCallIndex(workDir).edges).toBe(2);

    await rm(join(cacheDir, "a.json"));
    const idx = buildCallIndex(workDir);
    expect(idx.edges).toBe(1);
    expect(idx.byCallee.has("gone")).toBe(false);
    expect(idx.byCallee.get("kept")).toHaveLength(1);
  });

  it("does not leak one project's index when another is queried", async () => {
    // Only the active project's index is retained — a Map keyed by workDir
    // would hold every project ever queried for the life of the sidecar, at
    // ~36 MB each.
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [call("c", "alpha", f, "L1")]);
    expect(buildCallIndex(workDir).byCallee.has("alpha")).toBe(true);

    const other = await mkdtemp(join(tmpdir(), "marvin-callidx-other-"));
    await mkdir(join(other, "graphify-out", "cache"), { recursive: true });
    const otherSrc = join(other, "b.ts");
    await writeFile(otherSrc, "// src\n", "utf-8");
    await writeFile(
      join(other, "graphify-out", "cache", "x.json"),
      JSON.stringify({ raw_calls: [call("d", "beta", otherSrc, "L1")] }),
      "utf-8",
    );

    const second = buildCallIndex(other);
    expect(second.byCallee.has("beta")).toBe(true);
    expect(second.byCallee.has("alpha")).toBe(false); // not carried over

    // Returning to the first project reindexes it correctly rather than
    // serving the other project's data.
    const back = buildCallIndex(workDir);
    expect(back.byCallee.has("alpha")).toBe(true);
    expect(back.byCallee.has("beta")).toBe(false);
    await rm(other, { recursive: true, force: true });
  });
});

describe("callersOf", () => {
  it("merges repeated calls from one function into a single record", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [
      call("route_post", "target", f, "L188"),
      call("route_post", "target", f, "L191"),
      call("route_post", "target", f, "L196"),
    ]);
    const r = callersOf(buildCallIndex(workDir), "target");
    expect(r.callers).toHaveLength(1);
    expect(r.callers[0]?.lines).toEqual(["L188", "L191", "L196"]);
    expect(r.directSites).toBe(3);
  });

  it("accepts a decorated label as the query", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [call("c", "target", f, "L1")]);
    expect(callersOf(buildCallIndex(workDir), "target()").callers).toHaveLength(1);
  });

  it("reports no callers without claiming the symbol is dead", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [call("c", "other", f, "L1")]);
    const r = callersOf(buildCallIndex(workDir), "target");
    expect(r.callers).toEqual([]);
    expect(r.directSites).toBe(0);
  });

  it("flags a name common enough that the result is name-collision noise", async () => {
    const f = await realFile("a.ts");
    const many = Array.from({ length: AMBIGUITY_THRESHOLD + 5 }, (_, i) =>
      call(`caller_${i}`, "trim", f, `L${i}`),
    );
    await cacheEntry("a.json", many);
    const r = callersOf(buildCallIndex(workDir), "trim");
    expect(r.ambiguous).toBe(true);
  });

  it("walks a second hop back through the label index", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [
      call("mid_fn", "target", f, "L10"), // mid calls target
      call("outer_fn", "midFn", f, "L20"), // outer calls mid
    ]);
    const idx = buildCallIndex(workDir);
    const labels = new Map([["mid_fn", "midFn()"]]);

    const d1 = callersOf(idx, "target", 1, (n) => labels.get(n));
    expect(d1.callers.map((c) => c.callerNid)).toEqual(["mid_fn"]);

    const d2 = callersOf(idx, "target", 2, (n) => labels.get(n));
    expect(d2.callers.map((c) => c.callerNid).sort()).toEqual(["mid_fn", "outer_fn"]);
    expect(d2.callers.find((c) => c.callerNid === "outer_fn")?.depth).toBe(2);
  });

  it("does NOT widen the walk when the symbol is already ambiguous", async () => {
    // Widening an ambiguous name multiplies noise instead of adding signal.
    const f = await realFile("a.ts");
    const many = Array.from({ length: AMBIGUITY_THRESHOLD + 1 }, (_, i) =>
      call(`c_${i}`, "get", f, `L${i}`),
    );
    await cacheEntry("a.json", [...many, call("outer", "cZero", f, "L99")]);
    const labels = new Map([["c_0", "cZero()"]]);
    const r = callersOf(buildCallIndex(workDir), "get", 3, (n) => labels.get(n));
    expect(r.ambiguous).toBe(true);
    expect(r.callers.every((c) => c.depth === 1)).toBe(true);
  });

  it("terminates on a call cycle rather than looping forever", async () => {
    const f = await realFile("a.ts");
    await cacheEntry("a.json", [
      call("fn_a", "fnB", f, "L1"),
      call("fn_b", "fnA", f, "L2"),
    ]);
    const labels = new Map([
      ["fn_a", "fnA()"],
      ["fn_b", "fnB()"],
    ]);
    const r = callersOf(buildCallIndex(workDir), "fnB", 3, (n) => labels.get(n));
    expect(r.callers.map((c) => c.callerNid).sort()).toEqual(["fn_a", "fn_b"]);
  });
});
