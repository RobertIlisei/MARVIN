import { describe, expect, it } from "vitest";

import {
  type AdrIndex,
  deriveLinks,
  LINK_MARKER,
  renderLinkTrailer,
  stripLinkTrailer,
} from "../src/note-links";

// ADR-0065 addendum. Measured on a real project: 819 notes, 129 links, ALL of
// them index->item. Zero links between notes, so Obsidian showed two starbursts
// and graphify got no cross-document edges. The relationships were already in
// the prose; only the syntax that makes a reference an EDGE was missing.

const adrIndex: AdrIndex = new Map([
  ["211", "docs/adr/0211-sentinel-group-mfa"],
  ["64", "docs/adr/0064-gdpr-erasure-and-retention-purge"],
]);
const exists = (p: string) => ["src/app.ts", "ansible/site.yml"].includes(p);

describe("deriveLinks — ADR references", () => {
  it("resolves an ADR reference to its real file", () => {
    const { links } = deriveLinks("Land ADR-0211 storage cutover", adrIndex, exists);
    expect(links).toEqual(["[[docs/adr/0211-sentinel-group-mfa|ADR-0211]]"]);
  });

  it("matches the forms people actually write", () => {
    for (const text of ["ADR-0211", "ADR 211", "adr-211", "ADR0211"]) {
      expect(deriveLinks(text, adrIndex, exists).links.length, text).toBe(1);
    }
  });

  it("OMITS an unresolvable ADR rather than emitting a dead end", () => {
    // `[[ADR-9999]]` would render as a node that looks like a note and opens
    // nothing — worse than no link at all.
    expect(deriveLinks("see ADR-9999", adrIndex, exists).links).toEqual([]);
  });

  it("links each ADR once however often it's mentioned", () => {
    const { links } = deriveLinks("ADR-0211 … ADR-211 again … ADR-0211", adrIndex, exists);
    expect(links).toHaveLength(1);
  });
});

describe("deriveLinks — file references", () => {
  it("links a path that exists", () => {
    expect(deriveLinks("broken in ansible/site.yml", adrIndex, exists).links)
      .toEqual(["[[ansible/site.yml]]"]);
  });

  it("skips a path that no longer exists", () => {
    expect(deriveLinks("see src/deleted.ts", adrIndex, exists).links).toEqual([]);
  });

  it("skips a bare filename with no directory", () => {
    // "README.md" can't be resolved to one file; guessing invents an edge.
    expect(deriveLinks("update README.md", adrIndex, exists).links).toEqual([]);
  });

  it("puts ADRs before files, so the strongest edge reads first", () => {
    const { links } = deriveLinks("ADR-64 covers src/app.ts", adrIndex, exists);
    expect(links[0]).toMatch(/ADR-64/);
    expect(links[1]).toBe("[[src/app.ts]]");
  });
});

describe("the trailer is derived, delimited and regenerated", () => {
  it("emits nothing when nothing resolved", () => {
    // An empty "Related:" heading is noise, and would diff on every write.
    expect(renderLinkTrailer([])).toBe("");
  });

  it("round-trips: strip(render(x) appended) === original body", () => {
    const body = "The real note text.\nSecond line.";
    const withTrailer = body + renderLinkTrailer(["[[a]]", "[[b]]"]);
    expect(stripLinkTrailer(withTrailer)).toBe(body);
  });

  it("cannot accumulate — stripping is idempotent", () => {
    const body = "text";
    let doc = body + renderLinkTrailer(["[[a]]"]);
    for (let i = 0; i < 3; i++) doc = stripLinkTrailer(doc) + renderLinkTrailer(["[[a]]"]);
    expect(doc.match(new RegExp(LINK_MARKER, "g"))).toHaveLength(1);
    expect(stripLinkTrailer(doc)).toBe(body);
  });

  it("leaves a body with no trailer untouched", () => {
    expect(stripLinkTrailer("just a body")).toBe("just a body");
  });
});

describe("dedup normalises across link forms (found on the first real pass)", () => {
  it("does not link the same ADR twice via both its number and its path", () => {
    // An item that says "ADR-0211" AND "docs/adr/0211-….md" refers to ONE note.
    // Emitting both is a duplicate edge and a noisy trailer.
    const idx: AdrIndex = new Map([["211", "docs/adr/0211-three-level-mfa"]]);
    const { links } = deriveLinks(
      "Land ADR-0211 per docs/adr/0211-three-level-mfa.md",
      idx,
      () => true,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("|ADR-0211]]"); // the labelled form wins
  });
});
