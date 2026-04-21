import { describe, expect, it } from "vitest";

import { type GitOp, gitWritePolicy } from "./git-write-policy.js";

describe("gitWritePolicy — stage / unstage", () => {
  it("auto on stage with paths", () => {
    expect(gitWritePolicy({ kind: "stage", paths: ["a.ts"] }).class).toBe("auto");
  });
  it("deny on empty stage list", () => {
    expect(gitWritePolicy({ kind: "stage", paths: [] }).class).toBe("deny");
  });
  it("auto on unstage, deny on empty", () => {
    expect(gitWritePolicy({ kind: "unstage", paths: ["a.ts"] }).class).toBe("auto");
    expect(gitWritePolicy({ kind: "unstage", paths: [] }).class).toBe("deny");
  });
});

describe("gitWritePolicy — discard", () => {
  it("staged discard is auto — changes remain in working tree", () => {
    const d = gitWritePolicy({
      kind: "discard",
      paths: ["a.ts"],
      mode: "staged",
    });
    expect(d.class).toBe("auto");
  });

  it("working discard is confirm warn — edits are gone after", () => {
    const d = gitWritePolicy({
      kind: "discard",
      paths: ["a.ts", "b.ts"],
      mode: "working",
    });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("warn");
  });
});

describe("gitWritePolicy — commit", () => {
  const base: Extract<GitOp, { kind: "commit" }> = {
    kind: "commit",
    message: "feat: add thing",
    amend: false,
    hasPushedHead: false,
  };

  it("deny on empty message (non-amend)", () => {
    expect(gitWritePolicy({ ...base, message: "   " }).class).toBe("deny");
  });

  it("auto on a normal commit", () => {
    expect(gitWritePolicy(base).class).toBe("auto");
  });

  it("auto on amend when head is local only", () => {
    expect(gitWritePolicy({ ...base, amend: true }).class).toBe("auto");
  });

  it("confirm danger on amend of a pushed head", () => {
    const d = gitWritePolicy({ ...base, amend: true, hasPushedHead: true });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });
});

describe("gitWritePolicy — branch create / switch / delete", () => {
  it("auto on valid branch-create", () => {
    expect(
      gitWritePolicy({
        kind: "branch-create",
        name: "feat/foo",
        from: "main",
      }).class,
    ).toBe("auto");
  });

  it("deny on branch-create with shell-ish name", () => {
    expect(
      gitWritePolicy({
        kind: "branch-create",
        name: "foo; rm -rf /",
        from: "main",
      }).class,
    ).toBe("deny");
  });

  it("deny on branch-switch when tree is dirty", () => {
    expect(
      gitWritePolicy({
        kind: "branch-switch",
        name: "main",
        workingTreeClean: false,
      }).class,
    ).toBe("deny");
  });

  it("auto on clean branch-switch", () => {
    expect(
      gitWritePolicy({
        kind: "branch-switch",
        name: "main",
        workingTreeClean: true,
      }).class,
    ).toBe("auto");
  });

  it("deny on branch-delete of current branch", () => {
    expect(
      gitWritePolicy({
        kind: "branch-delete",
        name: "main",
        merged: true,
        isCurrent: true,
      }).class,
    ).toBe("deny");
  });

  it("confirm danger on branch-delete of unmerged branch", () => {
    const d = gitWritePolicy({
      kind: "branch-delete",
      name: "feat/wip",
      merged: false,
      isCurrent: false,
    });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });

  it("auto on branch-delete of merged branch", () => {
    expect(
      gitWritePolicy({
        kind: "branch-delete",
        name: "feat/done",
        merged: true,
        isCurrent: false,
      }).class,
    ).toBe("auto");
  });
});

describe("gitWritePolicy — push / pull / fetch", () => {
  it("deny plain --force always", () => {
    expect(
      gitWritePolicy({
        kind: "push",
        force: "plain",
        branch: "main",
        upstreamAhead: 0,
      }).class,
    ).toBe("deny");
  });

  it("confirm danger on --force-with-lease", () => {
    const d = gitWritePolicy({
      kind: "push",
      force: "with-lease",
      branch: "feat/foo",
      upstreamAhead: 0,
    });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });

  it("confirm warn when upstream is ahead on a regular push", () => {
    const d = gitWritePolicy({
      kind: "push",
      force: "none",
      branch: "main",
      upstreamAhead: 3,
    });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("warn");
  });

  it("auto on a regular push with upstream behind", () => {
    expect(
      gitWritePolicy({
        kind: "push",
        force: "none",
        branch: "main",
        upstreamAhead: 0,
      }).class,
    ).toBe("auto");
  });

  it("auto on pull --ff-only", () => {
    expect(gitWritePolicy({ kind: "pull", strategy: "ff-only" }).class).toBe(
      "auto",
    );
  });

  it("confirm warn on pull --rebase and pull --merge", () => {
    expect(gitWritePolicy({ kind: "pull", strategy: "rebase" }).class).toBe(
      "confirm",
    );
    expect(gitWritePolicy({ kind: "pull", strategy: "merge" }).class).toBe(
      "confirm",
    );
  });

  it("auto on fetch with safe remote", () => {
    expect(gitWritePolicy({ kind: "fetch", remote: "origin" }).class).toBe(
      "auto",
    );
  });

  it("deny on fetch with injected remote", () => {
    expect(
      gitWritePolicy({ kind: "fetch", remote: "origin; rm -rf /" }).class,
    ).toBe("deny");
  });
});
