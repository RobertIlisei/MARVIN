import { describe, expect, it } from "vitest";

import {
  HARD_DENY_DIR_SEGMENTS,
  hasDenySegment,
  IGNORE_DIR_NAMES,
  isSecretFileName,
  SECRET_FILE_PATTERNS,
} from "../src/fs-constants";

// These constants are shared between the LLM tool channel and the
// user-initiated write channel. Every item on these lists is load-bearing
// for ADR-0008's "single source of truth" invariant — tests pin the set
// so a casual removal gets caught.

describe("IGNORE_DIR_NAMES", () => {
  it("includes core build + cache dirs", () => {
    expect(IGNORE_DIR_NAMES.has("node_modules")).toBe(true);
    expect(IGNORE_DIR_NAMES.has(".git")).toBe(true);
    expect(IGNORE_DIR_NAMES.has(".next")).toBe(true);
    expect(IGNORE_DIR_NAMES.has(".turbo")).toBe(true);
    expect(IGNORE_DIR_NAMES.has("dist")).toBe(true);
    expect(IGNORE_DIR_NAMES.has("build")).toBe(true);
  });

  it("includes Python venv + cache dirs", () => {
    expect(IGNORE_DIR_NAMES.has(".venv")).toBe(true);
    expect(IGNORE_DIR_NAMES.has("venv")).toBe(true);
    expect(IGNORE_DIR_NAMES.has("__pycache__")).toBe(true);
  });
});

describe("HARD_DENY_DIR_SEGMENTS", () => {
  it("is a subset of IGNORE_DIR_NAMES minus .DS_Store", () => {
    for (const seg of HARD_DENY_DIR_SEGMENTS) {
      expect(IGNORE_DIR_NAMES.has(seg)).toBe(true);
    }
    expect(HARD_DENY_DIR_SEGMENTS.has(".DS_Store")).toBe(false);
  });

  it("denies .git and node_modules specifically", () => {
    expect(HARD_DENY_DIR_SEGMENTS.has(".git")).toBe(true);
    expect(HARD_DENY_DIR_SEGMENTS.has("node_modules")).toBe(true);
  });
});

describe("hasDenySegment", () => {
  it("returns true when any segment matches", () => {
    expect(hasDenySegment("a/.git/hook")).toBe(true);
    expect(hasDenySegment("node_modules/foo")).toBe(true);
    expect(hasDenySegment("apps/web/.next/cache")).toBe(true);
  });

  it("returns false for clean paths", () => {
    expect(hasDenySegment("apps/web/src/page.tsx")).toBe(false);
    expect(hasDenySegment("packages/runtime/index.ts")).toBe(false);
  });

  it("is segment-aware, not substring-matching", () => {
    // "gitignore" contains "git" but shouldn't match ".git" segment
    expect(hasDenySegment("docs/gitignore.md")).toBe(false);
    // "notnode_modules" would not match as a segment
    expect(hasDenySegment("docs/notnode_modules.md")).toBe(false);
  });
});

describe("isSecretFileName", () => {
  it("matches .env variants", () => {
    expect(isSecretFileName(".env")).toBe(true);
    expect(isSecretFileName(".env.local")).toBe(true);
    expect(isSecretFileName(".env.production")).toBe(true);
  });

  it("matches SSH keys", () => {
    expect(isSecretFileName("id_rsa")).toBe(true);
    expect(isSecretFileName("id_rsa.pub")).toBe(true);
    expect(isSecretFileName("id_ed25519")).toBe(true);
  });

  it("matches certificate files", () => {
    expect(isSecretFileName("cert.pem")).toBe(true);
    expect(isSecretFileName("bundle.p12")).toBe(true);
    expect(isSecretFileName("auth.pfx")).toBe(true);
  });

  it("doesn't flag harmless files", () => {
    expect(isSecretFileName("README.md")).toBe(false);
    expect(isSecretFileName("package.json")).toBe(false);
    expect(isSecretFileName("env.ts")).toBe(false);
    expect(isSecretFileName(".env.example")).toBe(true); // .env* matches — intentionally flagged so users copy with intent
  });
});

describe("SECRET_FILE_PATTERNS is non-empty", () => {
  it("won't silently become empty on future refactor", () => {
    expect(SECRET_FILE_PATTERNS.length).toBeGreaterThan(0);
  });
});
