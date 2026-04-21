import { describe, expect, it } from "vitest";

import {
  containsForbiddenFlag,
  isSafeCommitMessage,
  isSafePathspec,
  isSafeRef,
  isSafeRemote,
} from "./argv-guards.js";

describe("isSafeRef", () => {
  it("accepts ordinary branch names", () => {
    for (const ref of [
      "main",
      "feat/source-control",
      "release-1.0.0",
      "user/robert/fix-login",
      "v1.0.0",
    ]) {
      expect(isSafeRef(ref)).toBe(true);
    }
  });

  it("rejects shell-injection attempts", () => {
    for (const ref of [
      "; rm -rf /",
      "$(whoami)",
      "`id`",
      "foo|bar",
      "foo&bar",
      "foo>bar",
      "foo\0bar",
    ]) {
      expect(isSafeRef(ref)).toBe(false);
    }
  });

  it("rejects flag-like names", () => {
    for (const ref of [
      "-c",
      "--upload-pack=/bin/sh",
      "-foo",
      "--exec-path=/tmp",
    ]) {
      expect(isSafeRef(ref)).toBe(false);
    }
  });

  it("rejects reflog syntax and escape sequences", () => {
    for (const ref of ["main@{yesterday}", "foo..bar", "../escape", "bar//baz"]) {
      expect(isSafeRef(ref)).toBe(false);
    }
  });

  it("rejects boundary cases", () => {
    expect(isSafeRef("")).toBe(false);
    expect(isSafeRef(".foo")).toBe(false);
    expect(isSafeRef("foo.")).toBe(false);
    expect(isSafeRef("foo/")).toBe(false);
    expect(isSafeRef("foo.lock")).toBe(false);
    expect(isSafeRef("a".repeat(251))).toBe(false);
  });
});

describe("isSafePathspec", () => {
  it("accepts ordinary paths", () => {
    for (const p of [
      "src/index.ts",
      "apps/web/page.tsx",
      "file with spaces.txt",
      "unicode/café.md",
      ".gitignore",
    ]) {
      expect(isSafePathspec(p)).toBe(true);
    }
  });

  it("rejects flag-shaped paths", () => {
    expect(isSafePathspec("-flag")).toBe(false);
    expect(isSafePathspec("--foo")).toBe(false);
  });

  it("rejects pathspec magic prefix", () => {
    expect(isSafePathspec(":(exclude)foo")).toBe(false);
    expect(isSafePathspec(":!foo")).toBe(false);
    expect(isSafePathspec(":/foo")).toBe(false);
  });

  it("rejects NUL and oversized", () => {
    expect(isSafePathspec("foo\0bar")).toBe(false);
    expect(isSafePathspec("a".repeat(1025))).toBe(false);
    expect(isSafePathspec("")).toBe(false);
  });
});

describe("isSafeRemote", () => {
  it("accepts ordinary remote names", () => {
    for (const r of ["origin", "upstream", "gh-pages", "fork.local"]) {
      expect(isSafeRemote(r)).toBe(true);
    }
  });

  it("rejects injection / flag-shaped / empty", () => {
    for (const r of [
      "",
      "-origin",
      "origin; rm -rf /",
      "origin|bar",
      ".origin",
      "a".repeat(101),
    ]) {
      expect(isSafeRemote(r)).toBe(false);
    }
  });
});

describe("isSafeCommitMessage", () => {
  it("accepts a normal message", () => {
    expect(isSafeCommitMessage("feat: add thing")).toBe(true);
    expect(isSafeCommitMessage("multi\nline\nbody")).toBe(true);
  });

  it("rejects empty / whitespace-only / NUL / oversize", () => {
    expect(isSafeCommitMessage("")).toBe(false);
    expect(isSafeCommitMessage("   \n\t ")).toBe(false);
    expect(isSafeCommitMessage("bad\0null")).toBe(false);
    expect(isSafeCommitMessage("a".repeat(16_385))).toBe(false);
  });
});

describe("containsForbiddenFlag", () => {
  it("returns null for clean argv", () => {
    expect(
      containsForbiddenFlag(["status", "--porcelain=v2", "--branch", "-z"]),
    ).toBeNull();
    expect(containsForbiddenFlag(["add", "--", "src/index.ts"])).toBeNull();
  });

  it("detects every blocked flag with and without `=value`", () => {
    const cases: Array<[string[], string]> = [
      [["-c", "alias.x=!sh"], "-c"],
      [["-C", "/etc"], "-C"],
      [["--exec-path=/tmp/evil"], "--exec-path"],
      [["--git-dir=/tmp/other"], "--git-dir"],
      [["--work-tree=/tmp/escape"], "--work-tree"],
      [["--upload-pack=/bin/sh"], "--upload-pack"],
      [["--receive-pack=/bin/sh"], "--receive-pack"],
      [["--config-env=foo=bar"], "--config-env"],
      [["--super-prefix=evil/"], "--super-prefix"],
    ];
    for (const [argv, flag] of cases) {
      expect(containsForbiddenFlag(argv)).toBe(flag);
    }
  });
});
