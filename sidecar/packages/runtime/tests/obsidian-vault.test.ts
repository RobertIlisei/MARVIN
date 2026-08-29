import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_IGNORE_FILTERS,
  initVault,
  renderIndexNote,
  vaultStatus,
} from "../src/obsidian-vault";

// ADR-0065 — the project directory IS the vault. The load-bearing property is
// that we never damage a vault the user already configured: one of this
// machine's registered Obsidian vaults is a project directory, so "there is
// already an .obsidian/ here" is the expected case, not the edge case.

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "marvin-vault-"));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const dot = () => join(workDir, ".obsidian");
const appJson = () => join(dot(), "app.json");

async function seedNotes(counts: { memory?: number; backlog?: number; plans?: number }) {
  for (const [family, n] of Object.entries(counts)) {
    const dir = join(workDir, ".marvin", family);
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < (n ?? 0); i++) {
      await writeFile(join(dir, `note-${i}.md`), "---\nname: x\n---\n\nbody\n", "utf-8");
    }
  }
}

describe("vaultStatus", () => {
  it("reports a non-vault project honestly", async () => {
    const s = await vaultStatus(workDir);
    expect(s.isVault).toBe(false);
    expect(s.notes).toEqual({ memory: 0, backlog: 0, plans: 0 });
    expect(s.graphNotes).toBe(false);
  });

  it("counts the note families MARVIN maintains", async () => {
    await seedNotes({ memory: 3, backlog: 5, plans: 2 });
    const s = await vaultStatus(workDir);
    expect(s.notes).toEqual({ memory: 3, backlog: 5, plans: 2 });
  });
});

describe("initVault — creating a vault", () => {
  it("creates .obsidian/, the index note, and reports created:true", async () => {
    await seedNotes({ memory: 2, backlog: 1 });
    const r = await initVault(workDir, "my-project");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(existsSync(dot())).toBe(true);
    expect(existsSync(join(workDir, "MARVIN.md"))).toBe(true);
    expect(r.ignoreFiltersAdded).toEqual(DEFAULT_IGNORE_FILTERS);
  });

  it("writes ignore filters so the graph view shows notes, not node_modules", async () => {
    await initVault(workDir, "p");
    const cfg = JSON.parse(await readFile(appJson(), "utf-8"));
    expect(cfg.userIgnoreFilters).toContain("node_modules/");
    expect(cfg.userIgnoreFilters).toContain(".git/");
  });
});

describe("initVault — an existing vault is the user's, not ours", () => {
  it("NEVER overwrites settings it didn't write", async () => {
    await mkdir(dot(), { recursive: true });
    await writeFile(
      appJson(),
      JSON.stringify({ theme: "obsidian", promptDelete: false, userIgnoreFilters: ["private/"] }),
      "utf-8",
    );
    const r = await initVault(workDir, "p");
    expect(r.ok).toBe(true);
    expect(r.created).toBe(false); // it was already a vault

    const cfg = JSON.parse(await readFile(appJson(), "utf-8"));
    expect(cfg.theme).toBe("obsidian");        // untouched
    expect(cfg.promptDelete).toBe(false);      // untouched
    expect(cfg.userIgnoreFilters).toContain("private/"); // theirs kept
    expect(cfg.userIgnoreFilters).toContain("node_modules/"); // ours merged in
  });

  it("is idempotent — a second run adds nothing", async () => {
    await initVault(workDir, "p");
    const second = await initVault(workDir, "p");
    expect(second.ignoreFiltersAdded).toEqual([]);
    const cfg = JSON.parse(await readFile(appJson(), "utf-8"));
    expect(cfg.userIgnoreFilters.filter((f: string) => f === "node_modules/")).toHaveLength(1);
  });

  it("leaves a corrupt app.json alone rather than replacing it", async () => {
    // It's the user's file. A vault without our filters still works; a vault
    // with their config destroyed does not.
    await mkdir(dot(), { recursive: true });
    await writeFile(appJson(), "{ this is not json", "utf-8");
    const r = await initVault(workDir, "p");
    expect(r.ok).toBe(true);
    expect(r.ignoreFiltersAdded).toEqual([]);
    expect(await readFile(appJson(), "utf-8")).toBe("{ this is not json");
  });

  it("does not touch notes the user wrote", async () => {
    await writeFile(join(workDir, "My Note.md"), "mine", "utf-8");
    await initVault(workDir, "p");
    expect(await readFile(join(workDir, "My Note.md"), "utf-8")).toBe("mine");
  });
});

describe("renderIndexNote", () => {
  it("states the real counts and singularises correctly", async () => {
    await seedNotes({ memory: 1, backlog: 3 });
    const note = renderIndexNote(await vaultStatus(workDir), "proj");
    expect(note).toContain("# proj — MARVIN");
    expect(note).toMatch(/1 durable fact\b/);   // not "facts"
    expect(note).toMatch(/3 parked items/);
  });

  it("links the two hubs so the graph view has a shape", () => {
    const note = renderIndexNote(
      { isVault: true, preExisting: false, notes: { memory: 1, backlog: 1, plans: 0 }, graphNotes: false, hiddenFolderPlugin: true, dataviewPlugin: false },
      "p",
    );
    expect(note).toContain("[[memory]]");
    expect(note).toContain("[[backlog]]");
  });

  it("only advertises code-graph notes when they exist", () => {
    const base = { isVault: true, preExisting: false, notes: { memory: 0, backlog: 0, plans: 0 }, hiddenFolderPlugin: true, dataviewPlugin: false };
    expect(renderIndexNote({ ...base, graphNotes: false }, "p")).not.toMatch(/Code graph/);
    expect(renderIndexNote({ ...base, graphNotes: true }, "p")).toMatch(/Code graph/);
  });

  it("says plainly what MARVIN will not do", () => {
    const note = renderIndexNote(
      { isVault: true, preExisting: false, notes: { memory: 0, backlog: 0, plans: 0 }, graphNotes: false, hiddenFolderPlugin: true, dataviewPlugin: false },
      "p",
    );
    expect(note).toMatch(/does \*\*not\*\* edit notes you\ncreate/);
    expect(note).toMatch(/never deletes a note/);
  });
});

describe("the dot-folder trap (verified against a real vault, 2026-08-15)", () => {
  it("warns loudly when no hidden-folder plugin is enabled", async () => {
    // Obsidian does not index dot-prefixed folders, and every MARVIN note lives
    // under `.marvin/`. Without the plugin the vault opens showing MARVIN.md
    // with two broken links and nothing else.
    await seedNotes({ memory: 5 });
    const note = renderIndexNote(await vaultStatus(workDir), "p");
    expect(note).toMatch(/\[!warning\]/);
    expect(note).toMatch(/Hidden Folders Access/);
    expect(note).toMatch(/does not index folders whose name starts with a dot/);
  });

  it("drops the warning once the plugin is enabled", async () => {
    await mkdir(dot(), { recursive: true });
    await writeFile(
      join(dot(), "community-plugins.json"),
      JSON.stringify(["hidden-folders-access"]),
      "utf-8",
    );
    const s = await vaultStatus(workDir);
    expect(s.hiddenFolderPlugin).toBe(true);
    expect(renderIndexNote(s, "p")).not.toMatch(/\[!warning\]/);
  });

  it("does not mistake an unrelated plugin for the fix", async () => {
    await mkdir(dot(), { recursive: true });
    await writeFile(
      join(dot(), "community-plugins.json"),
      JSON.stringify(["dataview", "templater-obsidian"]),
      "utf-8",
    );
    expect((await vaultStatus(workDir)).hiddenFolderPlugin).toBe(false);
  });

  it("treats a missing or malformed plugin list as 'not enabled'", async () => {
    await mkdir(dot(), { recursive: true });
    expect((await vaultStatus(workDir)).hiddenFolderPlugin).toBe(false);
    await writeFile(join(dot(), "community-plugins.json"), "not json", "utf-8");
    expect((await vaultStatus(workDir)).hiddenFolderPlugin).toBe(false);
  });
});

// ADR-0090 — the index note promised Dataview filtering and shipped none,
// while the user had the plugin installed. Live queries only when the plugin
// is actually enabled: without it they render as inert code fences, which is
// worse than not offering them.
describe("index note — live Dataview views", () => {
  const base = {
    isVault: true, preExisting: false,
    notes: { memory: 5, backlog: 12, plans: 2 },
    graphNotes: false, hiddenFolderPlugin: true,
  };

  it("ships query blocks when Dataview is enabled", () => {
    const note = renderIndexNote({ ...base, dataviewPlugin: true }, "proj");
    expect(note).toContain("```dataview");
    expect(note).toContain('FROM ".marvin/backlog"');
    expect(note).toContain('WHERE status != "resolved"');
    expect(note).toContain('FROM ".marvin/memory"');
  });

  it("offers instructions instead of broken fences when it is not", () => {
    const note = renderIndexNote({ ...base, dataviewPlugin: false }, "proj");
    expect(note).not.toContain("```dataview");
    expect(note).toContain("Dataview");
    expect(note).toMatch(/re-run `obsidian_init`/);
  });
});
