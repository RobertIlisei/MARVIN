import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveInstructionFiles } from "../src/instruction-files";

// ADR-0119 — MARVIN reads a project's instruction files the way the agent
// ecosystem writes them: CLAUDE.md (Claude Code), AGENTS.md (Codex, Cursor,
// others), `@path` imports between them, one set per directory.

const dirs: string[] = [];
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "marvin-instr-")));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const text = (r: ReturnType<typeof resolveInstructionFiles>) => r.sections.map((s) => s.text).join("\n");
const roles = (r: ReturnType<typeof resolveInstructionFiles>, root: string) =>
  r.files.map((f) => `${f.path.slice(root.length + 1)}:${f.role}`);

const RULES = Array.from({ length: 20 }, (_, i) => `- rule ${i}: keep behaviour ${i} stable`).join("\n");

describe("resolveInstructionFiles — which file", () => {
  it("reads AGENTS.md when the project has no CLAUDE.md", () => {
    const root = project({ "AGENTS.md": "# Agents\nUse pnpm." });
    const r = resolveInstructionFiles(root, root);
    expect(text(r)).toContain("Use pnpm.");
    expect(roles(r, root)).toEqual(["AGENTS.md:loaded"]);
  });

  it("reads CLAUDE.md, and .claude/CLAUDE.md too", () => {
    const root = project({ "CLAUDE.md": "root rules", ".claude/CLAUDE.md": "dot rules" });
    expect(text(resolveInstructionFiles(root, root))).toMatch(/root rules[\s\S]*dot rules/);
  });

  it("never reads the personal or override variants", () => {
    const root = project({
      "CLAUDE.local.md": "personal", "AGENTS.local.md": "local", "AGENTS.override.md": "override",
      ".agents/AGENTS.md": "dot agents",
    });
    expect(resolveInstructionFiles(root, root).sections).toEqual([]);
  });

  it("expands CLAUDE.md's @AGENTS.md import and does not load AGENTS.md a second time", () => {
    const root = project({ "CLAUDE.md": "@AGENTS.md\n\nClaude-only: use the graph.", "AGENTS.md": "Shared: run make check." });
    const r = resolveInstructionFiles(root, root);
    expect(text(r)).toContain("Shared: run make check.");
    expect(text(r)).toContain("Claude-only: use the graph.");
    expect(text(r)).not.toContain("@AGENTS.md");
    expect(text(r).match(/run make check/g)).toHaveLength(1);
    expect(roles(r, root)).toEqual(["CLAUDE.md:loaded", "AGENTS.md:imported"]);
  });

  it("loads a distinct AGENTS.md alongside CLAUDE.md", () => {
    const other = Array.from({ length: 20 }, (_, i) => `- codex note ${i}`).join("\n");
    const root = project({ "CLAUDE.md": RULES, "AGENTS.md": other });
    const r = resolveInstructionFiles(root, root);
    expect(text(r)).toContain("codex note 19");
    expect(roles(r, root)).toEqual(["CLAUDE.md:loaded", "AGENTS.md:loaded"]);
  });

  it("skips a near-copy AGENTS.md and reports it as a duplicate (88 % of its lines in CLAUDE.md)", () => {
    const copy = RULES.split("\n").slice(0, 15).concat(["- extra a", "- extra b"]).join("\n");
    const root = project({ "CLAUDE.md": RULES, "AGENTS.md": copy });
    const r = resolveInstructionFiles(root, root);
    expect(text(r)).not.toContain("extra a");
    expect(roles(r, root)).toEqual(["CLAUDE.md:loaded", "AGENTS.md:duplicate"]);
  });
});

describe("resolveInstructionFiles — imports", () => {
  it("resolves relative to the importing file and follows nested imports", () => {
    const root = project({ "CLAUDE.md": "@docs/a.md", "docs/a.md": "A then @b.md", "docs/b.md": "B text" });
    expect(text(resolveInstructionFiles(root, root))).toContain("B text");
  });

  it("ignores @tokens inside fenced blocks and inline code", () => {
    const root = project({ "CLAUDE.md": "Write `@AGENTS.md` to import.\n```\n@AGENTS.md\n```", "AGENTS.md": "SECRET-SHARED" });
    const r = resolveInstructionFiles(root, root);
    // CLAUDE.md is left as written; AGENTS.md then loads in its own right
    // (distinct content), never as an import.
    expect(r.sections[0]?.text).toContain("Write `@AGENTS.md` to import.\n```\n@AGENTS.md\n```");
    expect(r.sections[0]?.text).not.toContain("SECRET-SHARED");
    expect(roles(r, root)).toEqual(["CLAUDE.md:loaded", "AGENTS.md:loaded"]);
  });

  it("refuses an import that escapes the project, by path or by symlink", () => {
    const outside = project({ "evil.md": "OUTSIDE-TEXT" });
    const root = project({ "CLAUDE.md": `@../${outside.split("/").pop()}/evil.md\n@link.md` });
    symlinkSync(join(outside, "evil.md"), join(root, "link.md"));
    const r = resolveInstructionFiles(root, root);
    expect(text(r)).not.toContain("OUTSIDE-TEXT");
    expect(text(r)).toContain("outside the project");
  });

  it("leaves an unresolvable @token as it was (it may be a mention)", () => {
    const root = project({ "CLAUDE.md": "Ask @robert before deploying." });
    expect(text(resolveInstructionFiles(root, root))).toContain("Ask @robert before deploying.");
  });

  it("survives an import cycle and caps the depth at four hops", () => {
    const root = project({
      "CLAUDE.md": "@a.md", "a.md": "A @b.md", "b.md": "B @a.md @c.md",
      "c.md": "C @d.md", "d.md": "D @e.md", "e.md": "E-TOO-DEEP",
    });
    const t = text(resolveInstructionFiles(root, root));
    expect(t).toContain("D");
    expect(t).not.toContain("E-TOO-DEEP");
    expect(t.match(/\bA\b/g)?.length).toBe(1);
  });
});
