import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARVIN_DATA_DIR = mkdtempSync(join(tmpdir(), "marvin-skills-stale-data-"));

import { describe, expect, it } from "vitest";

import type { SkillCloseFacts } from "../src/skill-brief";
import { decideSkillClose } from "../src/turn-close-hook";

const SCOPE_MET = "All done.\n\n**Scope met:** the change ships. Anything else, or should I stop?\n<!-- marvin:scope-met -->";
const stale = [{ name: "pr-review", ranAt: "2026-11-28T10:00:00.000Z", editAt: "2026-11-28T10:05:00.000Z" }];
const facts = (over: Partial<SkillCloseFacts> = {}): SkillCloseFacts => ({
  required: ["ponytail", "pr-review"],
  used: ["ponytail"],
  unavailable: [],
  blocks: 0,
  stale,
  ...over,
});

describe("decideSkillClose: stale closing reviews", () => {
  it("blocks, names the stale skill with the edit time, and asks to run it again", () => {
    const r = decideSkillClose(SCOPE_MET, facts());
    expect(r.block?.kind).toBe("skills-unused");
    expect(r.block?.reason).toContain("`pr-review`");
    expect(r.block?.reason).toMatch(/ran before your last edit at \d\d:\d\d; run it again/);
    expect(r.block?.reason).not.toContain("never ran");
  });

  it("names a never-run skill and a stale one in their own sentences", () => {
    const r = decideSkillClose(SCOPE_MET, facts({ used: [], required: ["ponytail", "pr-review"] }));
    expect(r.block?.reason).toContain("never ran in this session: `ponytail`");
    expect(r.block?.reason).toContain("`pr-review`");
    expect(r.block?.reason).toMatch(/ran before your last edit/);
  });

  it("non-strict keeps the two-refusal brake text, strict has none", () => {
    expect(decideSkillClose(SCOPE_MET, facts()).block?.reason).toContain("refusals the close is allowed");
    expect(decideSkillClose(SCOPE_MET, facts({ strict: true })).block?.reason).not.toContain("refusals the close is allowed");
  });

  it("a waiver discharges a stale skill like a missing one (non-strict)", () => {
    const r = decideSkillClose(`${SCOPE_MET}\nSkill not used: pr-review — docs-only edit after the review`, facts());
    expect(r.block).toBeNull();
    expect(r.waived).toEqual(["pr-review"]);
  });

  it("no stale entries and everything used: through", () => {
    expect(decideSkillClose(SCOPE_MET, facts({ stale: [], used: ["ponytail", "pr-review"] })).block).toBeNull();
  });
});
