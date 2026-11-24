/**
 * graphify 0.9.93 made a bare name that matches several nodes exit 3 with the
 * candidate ids on stdout (`query`, `explain`, `path`); 0.9.73 answered with a
 * fuzzy search. `graph_query` kept only the exit message, so the candidates, the
 * actual answer, were dropped. 0.9.118 also needs the `mcp` extra for `query`,
 * and a plain install dies with a Python traceback.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GRAPHIFY_EXTRAS_HINT } from "../src/graphify-bin";
import { graphMcpTools } from "../src/mcp-server";

let dir: string;
let savedBin: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gq-err-"));
  savedBin = process.env.GRAPHIFY_BIN;
});
afterEach(() => {
  if (savedBin === undefined) delete process.env.GRAPHIFY_BIN;
  else process.env.GRAPHIFY_BIN = savedBin;
  rmSync(dir, { recursive: true, force: true });
});

function fakeGraphify(script: string): void {
  const p = join(dir, "graphify");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
  process.env.GRAPHIFY_BIN = p;
}

async function graphQuery(question: string): Promise<string> {
  const t = graphMcpTools(dir).find((x) => x.name === "graph_query");
  if (!t) throw new Error("graph_query missing");
  const res = (await t.handler({ question } as never, {})) as { content: Array<{ text: string }> };
  return res.content.map((c) => c.text).join("\n");
}

describe("graph_query failure text", () => {
  it("keeps the candidate ids graphify prints on stdout when it exits 3", async () => {
    fakeGraphify(
      "echo \"Ambiguous: 'fact' matches 2 nodes in different files.\"\necho '    id: apps_api_zilier_fact'\necho 'Retry with the full node id.'\nexit 3",
    );
    const text = await graphQuery("fact");
    expect(text).toContain("graphify query failed");
    expect(text).toContain("id: apps_api_zilier_fact");
    expect(text).toContain("Retry with the full node id.");
  });

  it("says how to reinstall when graphify died on the missing mcp extra", async () => {
    fakeGraphify("echo \"ModuleNotFoundError: No module named 'anyio'\" >&2\nexit 1");
    const text = await graphQuery("how does x work");
    expect(text).toContain(GRAPHIFY_EXTRAS_HINT);
  });
});
