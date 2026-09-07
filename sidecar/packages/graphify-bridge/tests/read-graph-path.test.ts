import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { shortestPath } from "../src/read-graph";

/**
 * `graph_path` as a tracer-bullet tool (2026-09-07). The property under
 * test: with a `relations` filter the BFS takes the route code actually
 * takes, not the shortcut a `references` string mention offers, and every
 * hop names its file so the path reads as a touchpoint list.
 */

let dir: string;
let graphPath: string;

const node = (id: string, file: string) => ({ id, label: id, source_file: file, file_type: "code" });
const link = (source: string, target: string, relation: string) => ({ source, target, relation, confidence: "EXTRACTED" });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marvin-path-"));
  await mkdir(join(dir, "graphify-out"), { recursive: true });
  graphPath = join(dir, "graphify-out", "graph.json");
  // Structural route: OrdersPage -calls-> useOrders -imports-> ordersApi -calls-> OrdersRepo.
  // Shortcut: OrdersPage -references-> OrdersRepo (a string mention in a comment).
  // Island: Billing, no edges.
  await writeFile(
    graphPath,
    JSON.stringify({
      nodes: [
        node("OrdersPage", "web/src/pages/OrdersPage.tsx"),
        node("useOrders", "web/src/hooks/useOrders.ts"),
        node("ordersApi", "web/src/api/orders.ts"),
        node("OrdersRepo", "api/src/orders/OrdersRepo.ts"),
        node("Billing", "api/src/billing/Billing.ts"),
      ],
      links: [
        link("OrdersPage", "useOrders", "calls"),
        link("useOrders", "ordersApi", "imports"),
        link("ordersApi", "OrdersRepo", "calls"),
        link("OrdersPage", "OrdersRepo", "references"),
      ],
    }),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("shortestPath with a relations filter", () => {
  it("unfiltered, takes the references shortcut in one hop", () => {
    const hops = shortestPath(graphPath, "OrdersPage", "OrdersRepo");
    expect(hops?.map((h) => h.label)).toEqual(["OrdersPage", "OrdersRepo"]);
    // A hop carries the relation of the edge it leaves by; the last has none.
    expect(hops?.map((h) => h.relation)).toEqual(["references", undefined]);
  });

  it("filtered to structural relations, walks the three-hop route code takes", () => {
    const hops = shortestPath(graphPath, "OrdersPage", "OrdersRepo", { relations: ["calls", "imports"] });
    expect(hops?.map((h) => h.label)).toEqual(["OrdersPage", "useOrders", "ordersApi", "OrdersRepo"]);
    expect(hops?.map((h) => h.relation)).toEqual(["calls", "imports", "calls", undefined]);
  });

  it("every hop carries its file, endpoints included", () => {
    const hops = shortestPath(graphPath, "OrdersPage", "OrdersRepo", { relations: ["calls", "imports"] });
    expect(hops?.map((h) => h.sourceFile)).toEqual([
      "web/src/pages/OrdersPage.tsx",
      "web/src/hooks/useOrders.ts",
      "web/src/api/orders.ts",
      "api/src/orders/OrdersRepo.ts",
    ]);
    expect(shortestPath(graphPath, "OrdersPage", "OrdersPage")?.[0]?.sourceFile).toBe("web/src/pages/OrdersPage.tsx");
  });

  it("returns null when the endpoints connect only through excluded relations, and for an island", () => {
    expect(shortestPath(graphPath, "OrdersPage", "OrdersRepo", { relations: ["imports"] })).toBeNull();
    expect(shortestPath(graphPath, "OrdersPage", "Billing")).toBeNull();
    // An empty filter means no filter.
    expect(shortestPath(graphPath, "OrdersPage", "OrdersRepo", { relations: [] })?.length).toBe(2);
  });
});
