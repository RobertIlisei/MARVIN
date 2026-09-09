// ADR-0107 — lane membership is prefix-by-segment, never substring: a tab
// that owns `src/api` must not own `src/api-v2`, and the root lane owns all.

import { describe, expect, it } from "vitest";

import { describeLane, isInsideLane, laneVerdict, normaliseRel } from "../src/lanes";

describe("isInsideLane", () => {
  it("matches the prefix itself and paths beneath it, by segment", () => {
    expect(isInsideLane("src/api/users.ts", ["src/api"])).toBe(true);
    expect(isInsideLane("src/api", ["src/api"])).toBe(true);
    expect(isInsideLane("src/api-v2/users.ts", ["src/api"])).toBe(false);
    expect(isInsideLane("src/apix", ["src/api"])).toBe(false);
    expect(isInsideLane("docs/adr/0107.md", ["src/api", "docs/"])).toBe(true);
  });
  it("the root lane owns everything; an empty lane owns nothing", () => {
    expect(isInsideLane("anything/at/all", ["."])).toBe(true);
    expect(isInsideLane("anything", [])).toBe(false);
  });
  it("normalises leading ./ and trailing slashes on both sides", () => {
    expect(isInsideLane("./src/a.ts", ["src/"])).toBe(true);
    expect(normaliseRel("./a/b/")).toBe("a/b");
  });
});

describe("laneVerdict", () => {
  it("resolves relative targets against the checkout and reports outside-the-checkout as null", () => {
    expect(laneVerdict("src/a.ts", ["src"], "/proj")).toEqual({ inside: true, rel: "src/a.ts" });
    expect(laneVerdict("/proj/docs/x.md", ["src"], "/proj")).toEqual({ inside: false, rel: "docs/x.md" });
    expect(laneVerdict("/tmp/x", ["src"], "/proj")).toBeNull();
    expect(laneVerdict("/proj", ["."], "/proj")).toEqual({ inside: true, rel: "." });
  });
});

describe("describeLane", () => {
  it("shows up to four entries", () => {
    expect(describeLane(["a", "b"])).toBe("a, b");
    expect(describeLane(["a", "b", "c", "d", "e", "f"])).toBe("a, b, c, d (+2 more)");
  });
});
