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
      { isVault: true, preExisting: false, notes: { memory: 1, backlog: 1, plans: 0 }, graphNotes: false },
      "p",
    );
    expect(note).toContain("[[memory]]");
    expect(note).toContain("[[backlog]]");
  });

  it("only advertises code-graph notes when they exist", () => {
    const base = { isVault: true, preExisting: false, notes: { memory: 0, backlog: 0, plans: 0 } };
    expect(renderIndexNote({ ...base, graphNotes: false }, "p")).not.toMatch(/Code graph/);
    expect(renderIndexNote({ ...base, graphNotes: true }, "p")).toMatch(/Code graph/);
  });

  it("says plainly what MARVIN will not do", () => {
    const note = renderIndexNote(
      { isVault: true, preExisting: false, notes: { memory: 0, backlog: 0, plans: 0 }, graphNotes: false },
      "p",
    );
    expect(note).toMatch(/does \*\*not\*\* edit notes you\ncreate/);
    expect(note).toMatch(/never deletes a note/);
  });
});
