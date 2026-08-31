import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  authorName,
  listInstalledPlugins,
  readEnabledPlugins,
  readPluginMcpDeclarations,
  setEnabledPlugins,
  stageSanitisedPlugin,
} from "../src/plugin-loader";

// ADR-0053: installed Claude Code plugins are opt-in per project. Availability
// (a plugin in ~/.claude/plugins) is separate from activation (a name listed in
// <workDir>/.marvin/plugins.json). readEnabledPlugins is the pure activation
// reader — the guarantee that a project with no plugins.json loads nothing.

function tmpWorkDir(): string {
  return mkdtempSync(path.join(tmpdir(), "marvin-plugins-"));
}

function writePluginsJson(workDir: string, body: unknown): void {
  mkdirSync(path.join(workDir, ".marvin"), { recursive: true });
  writeFileSync(path.join(workDir, ".marvin", "plugins.json"), JSON.stringify(body), "utf-8");
}

describe("readEnabledPlugins (opt-in default)", () => {
  it("returns [] when no plugins.json exists — nothing auto-loads", () => {
    expect(readEnabledPlugins(tmpWorkDir())).toEqual([]);
  });

  it("returns the enabled names when listed", () => {
    const wd = tmpWorkDir();
    writePluginsJson(wd, { enabled: ["honeycomb", "code-review@claude-plugins-official"] });
    expect(readEnabledPlugins(wd)).toEqual(["honeycomb", "code-review@claude-plugins-official"]);
  });

  it("returns [] on a corrupt or shapeless file (fails safe)", () => {
    const wd = tmpWorkDir();
    mkdirSync(path.join(wd, ".marvin"), { recursive: true });
    writeFileSync(path.join(wd, ".marvin", "plugins.json"), "{ not json", "utf-8");
    expect(readEnabledPlugins(wd)).toEqual([]);
  });

  it("filters non-string entries", () => {
    const wd = tmpWorkDir();
    writePluginsJson(wd, { enabled: ["honeycomb", 42, null, "x"] });
    expect(readEnabledPlugins(wd)).toEqual(["honeycomb", "x"]);
  });
});

describe("setEnabledPlugins (Plugins-pane toggle)", () => {
  it("round-trips through readEnabledPlugins, deduped + sorted", () => {
    const wd = tmpWorkDir();
    setEnabledPlugins(wd, ["honeycomb", "code-review", "honeycomb"]);
    expect(readEnabledPlugins(wd)).toEqual(["code-review", "honeycomb"]);
  });

  it("overwrites a prior set (disable == not in the list)", () => {
    const wd = tmpWorkDir();
    setEnabledPlugins(wd, ["honeycomb"]);
    setEnabledPlugins(wd, []);
    expect(readEnabledPlugins(wd)).toEqual([]);
  });
});

describe("readPluginMcpDeclarations (the 2026-07-23 no-response regression)", () => {
  function pluginFixture(manifest: unknown, mcpJson?: unknown): string {
    const dir = mkdtempSync(path.join(tmpdir(), "marvin-plugfix-"));
    mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify(manifest),
      "utf-8",
    );
    if (mcpJson !== undefined) {
      writeFileSync(path.join(dir, ".mcp.json"), JSON.stringify(mcpJson), "utf-8");
    }
    return dir;
  }

  it("does NOT treat manifest fields (author / keywords) as MCP servers", () => {
    // The exact honeycomb shape that broke every turn: object + array fields
    // in plugin.json leaked into options.mcpServers via the `?? obj` fallback.
    const dir = pluginFixture({
      name: "honeycomb",
      author: { name: "Honeycomb", url: "https://honeycomb.io" },
      keywords: ["observability", "mcp"],
    });
    expect(readPluginMcpDeclarations(dir)).toEqual({});
  });

  it("keeps an explicit, valid manifest mcpServers field", () => {
    const dir = pluginFixture({
      name: "p",
      author: { name: "X" },
      mcpServers: { srv: { command: "npx", args: ["-y", "some-mcp"] } },
    });
    expect(Object.keys(readPluginMcpDeclarations(dir))).toEqual(["srv"]);
  });

  it("reads a bare .mcp.json map but filters non-server shapes", () => {
    const dir = pluginFixture(
      { name: "p" },
      {
        good: { command: "node", args: ["srv.js"] },
        remote: { type: "http", url: "https://mcp.example.com" },
        junk: { note: "no command or url" },
        arr: ["not", "a", "server"],
      },
    );
    expect(Object.keys(readPluginMcpDeclarations(dir)).sort()).toEqual(["good", "remote"]);
  });
});

describe("stageSanitisedPlugin (ADR-0054: agents stay, hooks never load)", () => {
  it("keeps skills/ commands/ AND agents/, strips hooks/ + manifest hooks field", () => {
    const src = mkdtempSync(path.join(tmpdir(), "marvin-stage-src-"));
    mkdirSync(path.join(src, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(src, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", hooks: { PreToolUse: [{ command: "evil.sh" }] } }),
      "utf-8",
    );
    for (const d of ["skills/s1", "commands", "agents", "hooks"]) {
      mkdirSync(path.join(src, d), { recursive: true });
    }
    writeFileSync(path.join(src, "skills/s1/SKILL.md"), "---\nname: s1\n---\nx", "utf-8");
    writeFileSync(path.join(src, "commands/cmd.md"), "c", "utf-8");
    writeFileSync(path.join(src, "agents/investigator.md"), "a", "utf-8");
    writeFileSync(path.join(src, "hooks/hooks.json"), "{}", "utf-8");

    const dest = path.join(mkdtempSync(path.join(tmpdir(), "marvin-stage-dst-")), "p");
    stageSanitisedPlugin(src, dest);

    expect(existsSync(path.join(dest, "skills/s1/SKILL.md"))).toBe(true);
    expect(existsSync(path.join(dest, "commands/cmd.md"))).toBe(true);
    expect(existsSync(path.join(dest, "agents/investigator.md"))).toBe(true); // ADR-0054 §1
    expect(existsSync(path.join(dest, "hooks"))).toBe(false); // ADR-0054 §2
    const manifest = JSON.parse(
      readFileSync(path.join(dest, ".claude-plugin", "plugin.json"), "utf-8"),
    );
    expect(manifest.hooks).toBeUndefined();
    expect(manifest.name).toBe("p");
  });
});

describe("authorName (provenance)", () => {
  it("handles string, object, and absent authors", () => {
    expect(authorName("Anthropic")).toBe("Anthropic");
    expect(authorName({ name: "Honeycomb", url: "x" })).toBe("Honeycomb");
    expect(authorName({ url: "x" })).toBeUndefined();
    expect(authorName(undefined)).toBeUndefined();
    expect(authorName(["a"])).toBeUndefined();
  });
});

describe("listInstalledPlugins (read model)", () => {
  it("never throws and returns an array reflecting enabled state", () => {
    const wd = tmpWorkDir();
    const list = listInstalledPlugins(wd);
    expect(Array.isArray(list)).toBe(true);
    // With nothing enabled, no summary is marked enabled.
    expect(list.every((p) => p.enabled === false)).toBe(true);
    // Shape guard on whatever is installed in this environment.
    for (const p of list) {
      expect(typeof p.name).toBe("string");
      expect(Array.isArray(p.skills)).toBe(true);
      expect(typeof p.hasMcp).toBe("boolean");
    }
  });
});
