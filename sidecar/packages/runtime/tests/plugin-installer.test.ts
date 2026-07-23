import { describe, expect, it } from "vitest";

import { buildCatalog, deriveMarketName, upsertInstalledPlugin } from "../src/plugin-installer";

// ADR-0053 Phase 3 — full-plugin install. The git-clone path needs the
// network, but the two fiddly pure pieces — merging the installed_plugins.json
// registry and deriving a stable marketplace name — are unit-testable.

describe("upsertInstalledPlugin (registry merge)", () => {
  const entry = {
    scope: "user",
    installPath: "/p/honeycomb/1.1.0",
    version: "1.1.0",
    installedAt: "t",
    lastUpdated: "t",
  };

  it("adds a plugin to an empty registry, defaulting version to 2", () => {
    const out = upsertInstalledPlugin({}, "honeycomb@market", entry);
    expect(out.version).toBe(2);
    expect(out.plugins!["honeycomb@market"]).toEqual([entry]);
  });

  it("replaces the user-scope entry, preserving other scopes for the same key", () => {
    const start = {
      version: 2,
      plugins: {
        "honeycomb@market": [
          { scope: "project", installPath: "/proj/hc", version: "1.0.0" },
          { scope: "user", installPath: "/old/hc", version: "1.0.0" },
        ],
      },
    };
    const out = upsertInstalledPlugin(start, "honeycomb@market", entry);
    const entries = out.plugins!["honeycomb@market"]!;
    // project entry kept, single user entry replaced (not duplicated).
    expect(entries.filter((e) => e.scope === "user")).toEqual([entry]);
    expect(entries.filter((e) => e.scope === "project")).toHaveLength(1);
  });

  it("leaves other plugins untouched", () => {
    const start = {
      version: 2,
      plugins: { "other@m": [{ scope: "user", installPath: "/o", version: "9" }] },
    };
    const out = upsertInstalledPlugin(start, "honeycomb@market", entry);
    expect(out.plugins!["other@m"]).toEqual(start.plugins["other@m"]);
    expect(out.plugins!["honeycomb@market"]).toEqual([entry]);
  });

  it("does not mutate the input object", () => {
    const start = { version: 2, plugins: {} };
    upsertInstalledPlugin(start, "k@m", entry);
    expect(start.plugins).toEqual({});
  });
});

describe("buildCatalog (marketplace browse)", () => {
  const markets = [
    {
      name: "official",
      plugins: [
        { name: "zeta", description: "z", category: "misc", source: "./p/zeta" },
        { name: "alpha", description: "a", source: { source: "github", repo: "x/a" } },
      ],
    },
    { name: "second", plugins: [{ name: "beta", description: "b", source: "./b" }] },
  ];

  it("flattens all marketplaces, sorted by name, carrying category", () => {
    const out = buildCatalog(markets, []);
    expect(out.map((p) => p.name)).toEqual(["alpha", "beta", "zeta"]);
    expect(out.find((p) => p.name === "zeta")).toMatchObject({
      marketplace: "official",
      category: "misc",
      installed: false,
    });
  });

  it("marks installed by BARE name from registry keys (any marketplace)", () => {
    const out = buildCatalog(markets, ["alpha@somewhere-else", "beta@second"]);
    expect(out.find((p) => p.name === "alpha")?.installed).toBe(true);
    expect(out.find((p) => p.name === "beta")?.installed).toBe(true);
    expect(out.find((p) => p.name === "zeta")?.installed).toBe(false);
  });
});

describe("deriveMarketName", () => {
  it("builds owner-repo from a github https URL", () => {
    expect(deriveMarketName("https://github.com/acme/tools.git")).toBe("acme-tools");
    expect(deriveMarketName("https://github.com/acme/tools")).toBe("acme-tools");
  });

  it("handles ssh and trailing slashes", () => {
    expect(deriveMarketName("git@github.com:acme/dev-tools.git")).toBe("acme-dev-tools");
    expect(deriveMarketName("https://example.com/x/y/")).toBe("x-y");
  });
});
