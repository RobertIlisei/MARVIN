import { describe, expect, it } from "vitest";

import { type GitOp, gitWritePolicy } from "./git-write-policy";

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

describe("gitWritePolicy — discard untracked (`git clean`)", () => {
  it("is confirm DANGER, not warn — there is no reflog behind it", () => {
    const d = gitWritePolicy({
      kind: "discard",
      paths: ["scratch.txt"],
      mode: "untracked",
    });
    expect(d.class).toBe("confirm");
    // The distinction from mode:"working" is the whole point: a
    // restored file can be dug out of the reflog, a cleaned one cannot.
    expect(d.severity).toBe("danger");
  });

  it("deny on empty path list, same as the other modes", () => {
    expect(
      gitWritePolicy({ kind: "discard", paths: [], mode: "untracked" }).class,
    ).toBe("deny");
  });
});

describe("gitWritePolicy — detached checkout", () => {
  it("confirm warn on a clean tree", () => {
    const d = gitWritePolicy({
      kind: "branch-switch",
      name: "v1.2.0",
      workingTreeClean: true,
      detach: true,
    });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("warn");
  });

  it("still auto when detach is absent — the default path is unchanged", () => {
    expect(
      gitWritePolicy({
        kind: "branch-switch",
        name: "main",
        workingTreeClean: true,
      }).class,
    ).toBe("auto");
  });

  it("dirty tree denies before detach is even considered", () => {
    expect(
      gitWritePolicy({
        kind: "branch-switch",
        name: "v1.2.0",
        workingTreeClean: false,
        detach: true,
      }).class,
    ).toBe("deny");
  });
});

describe("gitWritePolicy — stash", () => {
  it("push is auto even with an empty stash — it CREATES the first entry", () => {
    expect(
      gitWritePolicy({ kind: "stash", action: "push", entryCount: 0 }).class,
    ).toBe("auto");
  });

  it("pop / apply are auto when there is something to restore", () => {
    expect(
      gitWritePolicy({ kind: "stash", action: "pop", entryCount: 2 }).class,
    ).toBe("auto");
    expect(
      gitWritePolicy({ kind: "stash", action: "apply", entryCount: 2 }).class,
    ).toBe("auto");
  });

  it("deny pop / apply / drop against an empty stash", () => {
    for (const action of ["pop", "apply", "drop"] as const) {
      expect(
        gitWritePolicy({ kind: "stash", action, entryCount: 0 }).class,
      ).toBe("deny");
    }
  });

  it("drop is confirm danger — the entry is gone", () => {
    const d = gitWritePolicy({
      kind: "stash",
      action: "drop",
      entryCount: 1,
    });
    expect(d.class).toBe("confirm");
    expect(d.severity).toBe("danger");
  });
});
