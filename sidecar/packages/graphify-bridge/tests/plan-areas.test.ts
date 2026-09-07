import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { areasOfTitle, discoverAreas, tokensOf } from "../src/plan-areas";

/**
 * Layers are discovered, never assumed (2026-09-07). The property under
 * test: a project's areas come from where its files sit and what they are
 * called, so a monorepo and a single-package tree each yield their own
 * areas with their own words, and a flat tree yields none.
 */

let dir: string;
let n = 0;
const graphAt = async (files: Array<[string, string[]]>): Promise<string> => {
  const p = join(dir, `g${++n}`, "graphify-out", "graph.json");
  await mkdir(join(dir, `g${n}`, "graphify-out"), { recursive: true });
  const nodes = files.flatMap(([file, labels]) =>
    labels.map((label) => ({ id: `${file}:${label}`, label, source_file: `/repo/${file}`, file_type: "code" })),
  );
  await writeFile(p, JSON.stringify({ nodes, links: [] }));
  return p;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marvin-areas-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const monorepo: Array<[string, string[]]> = [
  ["apps/api/src/orders/OrdersController.ts", ["OrdersController", "createOrder"]],
  ["apps/api/src/orders/OrdersRepository.ts", ["OrdersRepository", "findAll"]],
  ["apps/api/src/invoices/InvoicesController.ts", ["InvoicesController"]],
  ["apps/api/src/db/migrations/V1__orders.sql", ["V1__orders"]],
  ["apps/api/src/db/migrations/V2__invoices.sql", ["V2__invoices"]],
  ["apps/web/src/pages/OrdersPage.tsx", ["OrdersPage"]],
  ["apps/web/src/pages/InvoicesPage.tsx", ["InvoicesPage"]],
  ["apps/web/src/hooks/useOrders.ts", ["useOrders"]],
  ["apps/web/src/hooks/useInvoices.ts", ["useInvoices"]],
  ["apps/web/src/components/OrderRow.tsx", ["OrderRow"]],
  ["apps/web/src/components/InvoiceRow.tsx", ["InvoiceRow"]],
  ["infrastructure/compose/base.yml", ["base"]],
  ["infrastructure/compose/prod.yml", ["prod"]],
  ["infrastructure/grafana/alerts.yml", ["alerts"]],
];

describe("discoverAreas", () => {
  it("splits a monorepo into its apps and infrastructure, recursing where a directory splits again", async () => {
    const areas = discoverAreas(await graphAt(monorepo));
    expect(areas?.areas.map((a) => a.name)).toEqual(["apps/api", "apps/web", "infrastructure"]);
    expect(areas?.fileCount).toBe(14);
  });

  it("descends through a lone src/ to find the split below it", async () => {
    const areas = discoverAreas(
      await graphAt([
        ["src/components/Button.tsx", ["Button"]],
        ["src/components/Modal.tsx", ["Modal"]],
        ["src/components/Table.tsx", ["Table"]],
        ["src/server/routes.ts", ["routes"]],
        ["src/server/handlers.ts", ["handlers"]],
        ["src/server/db.ts", ["db"]],
      ]),
    );
    // `src/` is every file's root, so it is stripped: the areas are what sits below it.
    expect(areas?.areas.map((a) => a.name)).toEqual(["components", "server"]);
  });

  it("folds test and dot-directories into their parent instead of making them areas", async () => {
    const areas = discoverAreas(
      await graphAt([
        ...monorepo,
        ["apps/web/tests/orders.spec.ts", ["orders"]],
        ["apps/web/tests/invoices.spec.ts", ["invoices"]],
        ["apps/web/tests/login.spec.ts", ["login"]],
        [".marvin/backlog/a.md", ["a"]],
        [".marvin/backlog/b.md", ["b"]],
        [".marvin/backlog/c.md", ["c"]],
      ]),
    );
    expect(areas?.areas.map((a) => a.name)).toEqual(["apps/api", "apps/web", "infrastructure"]);
  });

  it("yields nothing for a flat tree or a missing graph", async () => {
    expect(discoverAreas(await graphAt([["a.ts", ["a"]], ["b.ts", ["b"]], ["c.ts", ["c"]]]))).toBeNull();
    expect(discoverAreas(join(dir, "nope", "graph.json"))).toBeNull();
  });

  it("keeps a token in an area's vocabulary only when it is distinctive to that area", async () => {
    const areas = discoverAreas(await graphAt(monorepo));
    const api = areas!.areas.find((a) => a.name === "apps/api")!;
    const web = areas!.areas.find((a) => a.name === "apps/web")!;
    // "order"/"orders" is everywhere → in neither; "controller"/"migration" → api; "page" → web.
    expect(api.vocab).not.toContain("order");
    expect(web.vocab).not.toContain("order");
    expect(api.vocab).toEqual(expect.arrayContaining(["api", "controller", "migration"]));
    expect(web.vocab).toEqual(expect.arrayContaining(["web", "page"]));
    expect(web.vocab).not.toContain("controller");
    // "apps" names the parent of both, so it identifies neither.
    expect(api.vocab).not.toContain("app");
    expect(web.vocab).not.toContain("app");
    // Structural = directory names + own unique name; file stems are not.
    expect(api.structural).toEqual(expect.arrayContaining(["api", "migration"]));
    expect(api.structural).not.toContain("controller");
    expect(web.structural).toEqual(expect.arrayContaining(["web", "page", "hook", "component"]));
  });
});

describe("areasOfTitle", () => {
  it("maps a milestone title by a distinctive token, by an area's path, or not at all", async () => {
    const areas = discoverAreas(await graphAt(monorepo))!;
    expect(areasOfTitle(areas, "Flyway migration for the orders table")).toEqual(["apps/api"]);
    expect(areasOfTitle(areas, "Orders page renders one row")).toEqual(["apps/web"]);
    expect(areasOfTitle(areas, "Thin slice: migration + endpoint + Orders page")).toEqual(["apps/api", "apps/web"]);
    expect(areasOfTitle(areas, "Tune the alert thresholds in infrastructure/grafana")).toEqual(["infrastructure"]);
    expect(areasOfTitle(areas, "Update the README")).toEqual([]);
    // Structural mode ignores file-stem nouns: "controller" is a file name, "migration" a directory.
    expect(areasOfTitle(areas, "Orders controller", { structural: true })).toEqual([]);
    expect(areasOfTitle(areas, "Orders migration", { structural: true })).toEqual(["apps/api"]);
  });

  it("tokenises camelCase and folds plurals", () => {
    expect(tokensOf("OrdersRepository.findByTenant")).toEqual(["order", "repository", "find", "tenant"]);
    expect(tokensOf("db/migrations V2__invoices")).toEqual(["migration", "invoice"]);
  });
});
