import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildCallIndex } from "../src/call-index";
import { changeImpact, renderChangeImpact } from "../src/change-impact";
import { nodeLabelResolver } from "../src/read-graph";

/**
 * Diff-level blast radius. The property under test: callers OUTSIDE the
 * changed files are the report; callers inside it are churn the branch
 * already owns and must not inflate the number. Fixtures use absolute
 * `source_file`s (what graphify writes on a real run) and repo-relative
 * changed-file names (what `git diff --name-only` prints), because matching
 * the two spellings is where this would silently break.
 */

let workDir: string;
let cacheDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-impact-"));
  cacheDir = join(workDir, "graphify-out", "cache");
  await mkdir(cacheDir, { recursive: true });
  await mkdir(join(workDir, "src"), { recursive: true });
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function realFile(rel: string): Promise<string> {
  const p = join(workDir, rel);
  await writeFile(p, "// source\n", "utf-8");
  return p;
}

const call = (callerNid: string, callee: string, file: string, loc: string) => ({
  caller_nid: callerNid,
  callee,
  source_file: file,
  source_location: loc,
});

async function seed(): Promise<{ graphPath: string }> {
  const billing = await realFile("src/billing.ts");
  const api = await realFile("src/api.ts");
  const jobs = await realFile("src/jobs.ts");
  const graphPath = join(workDir, "graphify-out", "graph.json");
  await writeFile(
    graphPath,
    JSON.stringify({
      directed: false,
      nodes: [
        { id: "n_billing_file", label: "billing.ts", file_type: "code", source_file: billing, community: 1 },
        { id: "n_charge", label: "charge()", file_type: "code", source_file: billing, community: 1, community_name: "Billing" },
        { id: "n_refund", label: "refund()", file_type: "code", source_file: billing, community: 1, community_name: "Billing" },
        { id: "n_route", label: "POST()", file_type: "code", source_file: api, community: 2, community_name: "HTTP routes" },
        { id: "n_nightly", label: "nightlyReconcile()", file_type: "code", source_file: jobs, community: 3, community_name: "Community 3" },
        { id: "n_doc", label: "BILLING.md", file_type: "document", source_file: join(workDir, "docs/BILLING.md") },
      ],
      links: [],
    }),
  );
  await writeFile(
    join(cacheDir, "calls.json"),
    JSON.stringify({
      nodes: [],
      edges: [],
      raw_calls: [
        call("n_route", "charge", api, "L12"), // external: api.ts is not on the branch
        call("n_nightly", "charge", jobs, "L40"), // external
        call("n_nightly", "refund", jobs, "L41"), // external
        call("n_refund", "charge", billing, "L7"), // internal: billing.ts is on the branch
      ],
    }),
  );
  return { graphPath };
}

describe("changeImpact", () => {
  it("reports callers outside the branch and keeps internal churn out of the count", async () => {
    const { graphPath } = await seed();
    const r = changeImpact({
      workDir,
      graphPath,
      index: buildCallIndex(workDir),
      files: ["src/billing.ts"],
    });
    expect(r.changedSymbols).toBe(2); // charge, refund — the file node is not a symbol
    expect(r.externalCallers.map((c) => `${c.callee}<-${c.label}@${c.file}`)).toEqual([
      "charge<-POST()@src/api.ts",
      "charge<-nightlyReconcile()@src/jobs.ts",
      "refund<-nightlyReconcile()@src/jobs.ts",
    ]);
    expect(r.internalCallSites).toBe(1);
    expect(r.communities).toEqual([{ id: 1, name: "Billing", symbols: 2 }]);
    expect(r.unindexed).toEqual([]);
  });

  it("names changed files the graph does not know, and ignores document nodes", async () => {
    const { graphPath } = await seed();
    const r = changeImpact({
      workDir,
      graphPath,
      index: buildCallIndex(workDir),
      files: ["src/billing.ts", "docs/BILLING.md", "README.md"],
    });
    expect(r.unindexed).toEqual(["README.md", "docs/BILLING.md"]);
    expect(r.changedSymbols).toBe(2);
  });

  it("treats a placeholder community name as unnamed", async () => {
    const { graphPath } = await seed();
    const r = changeImpact({
      workDir,
      graphPath,
      index: buildCallIndex(workDir),
      files: ["src/jobs.ts"],
    });
    expect(r.communities).toEqual([{ id: 3, name: null, symbols: 1 }]);
  });

  it("renders external callers grouped by callee, in file order", async () => {
    const { graphPath } = await seed();
    const r = changeImpact({ workDir, graphPath, index: buildCallIndex(workDir), files: ["src/billing.ts"] });
    const text = renderChangeImpact(r, { base: "origin/main", limit: 30 });
    expect(text).toContain("Branch vs origin/main: 1 file(s), 2 code symbol(s), 3 external caller(s), 1 internal call site(s).");
    expect(text).toContain("  charge:\n    - POST() — src/api.ts:L12\n    - nightlyReconcile() — src/jobs.ts:L40");
    expect(text).toContain("  - Billing — 2 symbol(s)");
  });
});

describe("nodeLabelResolver", () => {
  it("resolves a cache-style id by suffix, and refuses a tie", async () => {
    const graphPath = join(workDir, "graphify-out", "graph.json");
    await writeFile(
      graphPath,
      JSON.stringify({
        nodes: [
          { id: "apps_api_gdpr_tenanterasureservice_tenanterasureservice_lockouttenant", label: "lockOutTenant()" },
          { id: "apps_api_gdpr_tenanterasureservice_tenanterasureservice_archive", label: "archive()" },
          { id: "apps_web_routes_detail_detail_archive", label: "archive() [web]" },
          { id: "exact_id", label: "Exact" },
        ],
        links: [],
      }),
    );
    const resolve = nodeLabelResolver(graphPath);
    expect(resolve("exact_id")).toBe("Exact");
    // The cache id is the graph id minus the path prefix.
    expect(resolve("tenanterasureservice_tenanterasureservice_lockouttenant")).toBe("lockOutTenant()");
    // Two nodes end in `_archive` but only one ends in the full cache id.
    expect(resolve("tenanterasureservice_tenanterasureservice_archive")).toBe("archive()");
    // A genuinely ambiguous suffix resolves to nothing, not to a guess.
    expect(resolve("archive")).toBeUndefined();
    expect(resolve("never_seen")).toBeUndefined();
  });
});
