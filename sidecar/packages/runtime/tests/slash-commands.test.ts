import { describe, expect, it } from "vitest";

import {
  expandNativeCommand,
  filterCommands,
  mergeCatalogs,
  normaliseCommands,
  rankCommand,
} from "../src/slash-commands";

// The composer's `/` autocomplete: MARVIN passed slash commands through to the
// SDK correctly but offered no autocomplete, descriptions, or validation — so a
// command only worked if you already knew its exact name. These pin the pure
// catalog logic behind the fix.

describe("normaliseCommands", () => {
  it("keeps name/description/argumentHint and strips a leading slash", () => {
    const out = normaliseCommands([
      { name: "/emil-design-eng", description: "UI polish philosophy", argumentHint: "<area>" },
    ]);
    expect(out).toEqual([
      { name: "emil-design-eng", description: "UI polish philosophy", argumentHint: "<area>" },
    ]);
  });

  it("sorts alphabetically and drops duplicates", () => {
    const out = normaliseCommands([
      { name: "zeta", description: "" },
      { name: "alpha", description: "" },
      { name: "alpha", description: "dupe" },
    ]);
    expect(out.map((c) => c.name)).toEqual(["alpha", "zeta"]);
  });

  it("is defensive — bad shapes never throw or leak through", () => {
    expect(normaliseCommands(null)).toEqual([]);
    expect(normaliseCommands("nope")).toEqual([]);
    expect(normaliseCommands([null, 42, {}, { description: "no name" }])).toEqual([]);
    const out = normaliseCommands([{ name: "ok", description: 5, argumentHint: null }]);
    expect(out).toEqual([{ name: "ok", description: "", argumentHint: "" }]);
  });
});

describe("filterCommands (autocomplete ranking)", () => {
  const cmds = normaliseCommands([
    { name: "emil-design-eng", description: "UI polish and component design" },
    { name: "review-animations", description: "Review motion code against a craft bar" },
    { name: "improve-animations", description: "Audit motion and plan fixes" },
    { name: "prototype", description: "Build several UI versions behind a picker" },
    { name: "graphify", description: "knowledge graph" },
  ]);

  it("ranks exact, then prefix, then substring, then description", () => {
    expect(filterCommands(cmds, "emil")[0]!.name).toBe("emil-design-eng");
    expect(filterCommands(cmds, "prototype")[0]!.name).toBe("prototype");
    // "animations" is a substring of two names — both rank above a
    // description-only match.
    const anim = filterCommands(cmds, "animations").map((c) => c.name);
    expect(anim).toContain("review-animations");
    expect(anim).toContain("improve-animations");
  });

  it("matches on description when the name doesn't contain the query", () => {
    const hits = filterCommands(cmds, "craft").map((c) => c.name);
    expect(hits).toEqual(["review-animations"]);
  });

  it("empty query returns everything (the bare `/` case)", () => {
    expect(filterCommands(cmds, "")).toHaveLength(cmds.length);
  });

  it("respects the limit", () => {
    expect(filterCommands(cmds, "", 2)).toHaveLength(2);
  });

  it("no match returns empty rather than everything", () => {
    expect(filterCommands(cmds, "zzzznope")).toEqual([]);
  });
});

// The autocomplete was unreliable for two concrete reasons, both pinned here:
// (1) the catalog was truncated at the display limit before it ever reached the
// client, and (2) plain substring matching can't handle hyphenated names.
describe("rankCommand — hyphen-aware matching", () => {
  const cmd = (name: string, description = "") => ({ name, description, argumentHint: "" });

  it("ranks exact above prefix above segment-prefix above substring", () => {
    expect(rankCommand(cmd("prototype"), "prototype")).toBe(0);
    expect(rankCommand(cmd("improve-animations"), "improve")).toBe(1);
    // "anim" is a prefix of the SECOND segment — a plain prefix test misses it.
    expect(rankCommand(cmd("improve-animations"), "anim")).toBe(2);
    expect(rankCommand(cmd("improve-animations"), "mations")).toBe(3);
  });

  it("matches initials — 'ia' finds improve-animations", () => {
    expect(rankCommand(cmd("improve-animations"), "ia")).toBe(4);
    expect(rankCommand(cmd("emil-design-eng"), "ede")).toBe(4);
  });

  it("matches the de-hyphenated name as a subsequence", () => {
    expect(rankCommand(cmd("improve-animations"), "improveanim")).toBe(5);
    expect(rankCommand(cmd("pick-ui-library"), "pickui")).toBeLessThanOrEqual(5);
  });

  it("falls back to description, and returns null for a genuine miss", () => {
    expect(rankCommand(cmd("review-animations", "craft bar for motion"), "craft")).toBe(6);
    expect(rankCommand(cmd("prototype", "build variants"), "zzzq")).toBeNull();
  });

  it("orders a realistic query sensibly", () => {
    const all = [
      cmd("improve-animations", "audit motion"),
      cmd("find-animation-opportunities", "find motion gaps"),
      cmd("review-animations", "review motion"),
      cmd("animation-vocabulary", "name the effect"),
    ];
    const names = filterCommands(all, "anim").map((c) => c.name);
    // The command whose NAME starts with the query wins.
    expect(names[0]).toBe("animation-vocabulary");
    expect(names).toHaveLength(4);
  });
});

describe("filterCommands — no silent truncation of the catalog", () => {
  it("an empty query does not drop commands past the old 40 limit", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      name: `cmd-${String(i).padStart(2, "0")}`,
      description: "",
      argumentHint: "",
    }));
    // The client fetches the whole catalog and filters locally, so a transport
    // cap made late-alphabet commands permanently unfindable.
    expect(filterCommands(many, "").length).toBeGreaterThanOrEqual(51);
  });
});

// ── Native MARVIN commands (ADR-0063) ───────────────────────────────────────
// `backlog_groom` is an in-process MCP tool, so it appears in neither source
// the catalog is otherwise built from (skills on disk, SDK-reported commands).
// It shipped with no trigger at all until these entries existed.

describe("native commands", () => {
  it("offers /groom in the catalog even with nothing captured or on disk", () => {
    const merged = mergeCatalogs([], []);
    expect(merged.map((c) => c.name)).toContain("groom");
  });

  it("is not shadowed by a same-named skill in some project", () => {
    const merged = mergeCatalogs([], [{ name: "groom", description: "someone else's", argumentHint: "" }]);
    const groom = merged.find((c) => c.name === "groom");
    expect(groom?.description).toMatch(/backlog/i);
    expect(merged.filter((c) => c.name === "groom")).toHaveLength(1);
  });

  it("expands /groom into an instruction that forbids acting on the findings", () => {
    const out = expandNativeCommand("/groom");
    expect(out).toBeTruthy();
    expect(out).toMatch(/backlog_groom/);
    expect(out).toMatch(/do not resolve, dismiss, merge, re-prioritise, or edit/i);
    expect(out).toMatch(/do not start working on one/i);
  });

  it("carries trailing arguments through as an extra instruction", () => {
    const out = expandNativeCommand("/groom only the high severity ones");
    expect(out).toContain("Additional instruction: only the high severity ones");
  });

  it("leaves ordinary messages and unknown commands alone", () => {
    expect(expandNativeCommand("groom the backlog please")).toBeNull();
    expect(expandNativeCommand("/notacommand")).toBeNull();
    expect(expandNativeCommand("")).toBeNull();
  });

  it("does not fire on a message that merely MENTIONS the command", () => {
    // Prose about /groom is not an invocation of it.
    expect(expandNativeCommand("what does /groom do?")).toBeNull();
  });

  it("is case-insensitive on the command name", () => {
    expect(expandNativeCommand("/GROOM")).toBeTruthy();
  });
});
