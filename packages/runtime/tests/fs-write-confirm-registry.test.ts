import { describe, expect, it } from "vitest";

import {
  consumeConfirmToken,
  mintConfirmToken,
} from "../src/fs-write-confirm-registry";

// The token registry is the user-initiated channel's equivalent of the
// turn-scoped `confirm-registry`. These tests pin the structural
// compare that ADR-0008 relies on to prevent "mint for harmless op,
// replay with dangerous op".

const CWD = "/tmp/proj";

describe("mintConfirmToken", () => {
  it("returns an opaque token + expiresIn", () => {
    const r = mintConfirmToken(
      { kind: "delete-permanent", paths: [`${CWD}/a.ts`] },
      CWD,
    );
    expect(typeof r.token).toBe("string");
    expect(r.token.length).toBeGreaterThan(16);
    expect(r.expiresIn).toBe(60);
  });

  it("mints unique tokens on repeat calls", () => {
    const a = mintConfirmToken(
      { kind: "delete-permanent", paths: [`${CWD}/a.ts`] },
      CWD,
    );
    const b = mintConfirmToken(
      { kind: "delete-permanent", paths: [`${CWD}/a.ts`] },
      CWD,
    );
    expect(a.token).not.toBe(b.token);
  });
});

describe("consumeConfirmToken — success", () => {
  it("consumes a matching token once", () => {
    const op = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/doomed.ts`],
    };
    const { token } = mintConfirmToken(op, CWD);

    const first = consumeConfirmToken(token, { op, cwd: CWD });
    expect(first.ok).toBe(true);

    // Second attempt fails — tokens are one-shot.
    const second = consumeConfirmToken(token, { op, cwd: CWD });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toMatch(/unknown|consumed/);
    }
  });
});

describe("consumeConfirmToken — rejection", () => {
  it("rejects a missing token", () => {
    const r = consumeConfirmToken(null, {
      op: { kind: "delete-permanent", paths: [`${CWD}/a.ts`] },
      cwd: CWD,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a mismatched cwd", () => {
    const op = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/a.ts`],
    };
    const { token } = mintConfirmToken(op, CWD);
    const r = consumeConfirmToken(token, { op, cwd: "/different/cwd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/cwd/);
  });

  it("rejects a mismatched op.kind", () => {
    const mintedOp = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/a.ts`],
    };
    const replayOp = {
      kind: "delete-trash" as const,
      paths: [`${CWD}/a.ts`],
    };
    const { token } = mintConfirmToken(mintedOp, CWD);
    const r = consumeConfirmToken(token, { op: replayOp, cwd: CWD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/op/);
  });

  it("rejects when replay paths differ from minted paths", () => {
    const mintedOp = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/small.ts`],
    };
    const replayOp = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/big.ts`],
    };
    const { token } = mintConfirmToken(mintedOp, CWD);
    const r = consumeConfirmToken(token, { op: replayOp, cwd: CWD });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/op/);
  });

  it("rejects when replay carries MORE paths than minted", () => {
    const mintedOp = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/a.ts`],
    };
    const replayOp = {
      kind: "delete-permanent" as const,
      paths: [`${CWD}/a.ts`, `${CWD}/b.ts`],
    };
    const { token } = mintConfirmToken(mintedOp, CWD);
    const r = consumeConfirmToken(token, { op: replayOp, cwd: CWD });
    expect(r.ok).toBe(false);
  });

  it("rejects a rename replay using swapped from/to", () => {
    const mintedOp = {
      kind: "rename" as const,
      from: `${CWD}/a.ts`,
      to: `${CWD}/b.ts`,
    };
    const replayOp = {
      kind: "rename" as const,
      from: `${CWD}/b.ts`,
      to: `${CWD}/a.ts`,
    };
    const { token } = mintConfirmToken(mintedOp, CWD);
    const r = consumeConfirmToken(token, { op: replayOp, cwd: CWD });
    expect(r.ok).toBe(false);
  });
});
