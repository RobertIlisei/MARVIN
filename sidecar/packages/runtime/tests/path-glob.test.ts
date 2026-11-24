import { describe, expect, it } from "vitest";

import { matchesAnyGlob, matchesGlob, sanitizeGlobs } from "../src/path-glob";

describe("path-glob (ADR-0138)", () => {
  it("`*` stays inside one directory, `**` crosses them", () => {
    expect(matchesGlob("apps/web/a.ts", "apps/web/*.ts")).toBe(true);
    expect(matchesGlob("apps/web/sub/a.ts", "apps/web/*.ts")).toBe(false);
    expect(matchesGlob("apps/web/sub/a.ts", "apps/web/**/*.ts")).toBe(true);
    expect(matchesGlob("apps/web/a.ts", "apps/web/**/*.ts")).toBe(true);
    expect(matchesGlob("apps/web/sub/deep/a.ts", "apps/**")).toBe(true);
  });

  it("a plain directory (with or without a trailing slash) matches everything under it", () => {
    expect(matchesGlob("db/migrations/001.sql", "db/migrations")).toBe(true);
    expect(matchesGlob("db/migrations/001.sql", "db/migrations/")).toBe(true);
    expect(matchesGlob("db/migrations2/001.sql", "db/migrations")).toBe(false);
    expect(matchesGlob("db/migrations", "db/migrations")).toBe(true);
  });

  it("a pattern with no slash matches the file name at any depth, one with a slash is anchored at the root", () => {
    expect(matchesGlob("a/b/schema.sql", "*.sql")).toBe(true);
    expect(matchesGlob("schema.sql", "*.sql")).toBe(true);
    expect(matchesGlob("a/b/schema.sql.bak", "*.sql")).toBe(false);
    expect(matchesGlob("x/db/a.sql", "db/*.sql")).toBe(false);
    expect(matchesGlob("db/a.sql", "./db/*.sql")).toBe(true);
  });

  it("`?` is one non-slash character and regex metacharacters are literal", () => {
    expect(matchesGlob("a1.ts", "a?.ts")).toBe(true);
    expect(matchesGlob("a/.ts", "a?.ts")).toBe(false);
    expect(matchesGlob("a+b(1).ts", "a+b(1).ts")).toBe(true);
    expect(matchesGlob("aXb.ts", "a.b.ts")).toBe(false);
  });

  it("matchesAnyGlob is false for an empty list and true when any pattern matches", () => {
    expect(matchesAnyGlob("src/a.ts", [])).toBe(false);
    expect(matchesAnyGlob("src/a.ts", ["docs", "src/**"])).toBe(true);
  });

  it("sanitizeGlobs bounds a list read from a user file", () => {
    expect(sanitizeGlobs("nope")).toEqual([]);
    expect(sanitizeGlobs(["src/**", 4, "", "  ", "x".repeat(300), "a\0b", "./docs/", "src/**"])).toEqual(["src/**", "docs"]);
    expect(sanitizeGlobs(Array.from({ length: 50 }, (_, i) => `d${i}`))).toHaveLength(20);
  });

  it("a pathological pattern cannot hang the matcher", () => {
    const evil = `${"*".repeat(40)}x`;
    const t = Date.now();
    matchesGlob("a".repeat(200), evil);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
