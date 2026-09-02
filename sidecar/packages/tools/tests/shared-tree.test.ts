// Pins the line between "changes the tree out from under another session" and
// "leave it alone". Both directions matter: a false negative silently
// reinstates the 2026-09-01 incident (one session branch-hopping while another
// edited the same checkout), and a false positive puts a confirm in front of a
// read-only command in the user's default auto mode, which is how a guard
// gets switched off.

import { describe, expect, it } from "vitest";

import {
  classifySharedTreeRisk,
  describeSharedTreeRisk,
  type SharedTreeRisk,
} from "../src/shared-tree";

describe("classifySharedTreeRisk — commands that move the shared tree", () => {
  const movesHead = [
    "git checkout dep/openapi-fetch",
    "git checkout -b feature/thing",
    "git switch main",
    "git reset --soft HEAD~1",
    "git reset",
    "git pull --rebase",
    "git bisect start",
  ];
  for (const cmd of movesHead) {
    it(`flags \`${cmd}\` as moving HEAD`, () => {
      expect(classifySharedTreeRisk(cmd)?.risk).toBe("moves-head");
    });
  }

  const rewritesHistory = [
    "git rebase gitlab/main",
    "git rebase --continue",
    "git merge origin/main",
    "git cherry-pick abc1234",
    "git commit --amend --no-edit",
    "git filter-branch --tree-filter true HEAD",
  ];
  for (const cmd of rewritesHistory) {
    it(`flags \`${cmd}\` as rewriting history`, () => {
      expect(classifySharedTreeRisk(cmd)?.risk).toBe("rewrites-history");
    });
  }

  const rewritesWorktree = [
    "git stash",
    "git stash pop",
    "git restore src/app.ts",
    "git apply /tmp/fix.patch",
    "git am < patch.mbox",
  ];
  for (const cmd of rewritesWorktree) {
    it(`flags \`${cmd}\` as rewriting the worktree`, () => {
      expect(classifySharedTreeRisk(cmd)?.risk).toBe("rewrites-worktree");
    });
  }

  it("reports the verb that matched, for the confirm card", () => {
    expect(classifySharedTreeRisk("git checkout main")?.verb).toBe("git checkout");
    expect(classifySharedTreeRisk("git rebase -i HEAD~3")?.verb).toBe("git rebase");
  });

  it("catches the exact reflog shape from the 2026-09-01 incident", () => {
    // Verbatim from the agri-saas-platform reflog: this pair is what pulled
    // the tree out from under the hotfix session.
    expect(
      classifySharedTreeRisk("git checkout chore/dependabot-mr-triage-2026-09-01"),
    ).not.toBeNull();
    expect(classifySharedTreeRisk("git rebase gitlab/main")).not.toBeNull();
  });
});

describe("classifySharedTreeRisk — commands it must leave alone", () => {
  const safe = [
    // Read-only git.
    "git status --porcelain=v1",
    "git log --oneline -5",
    "git diff HEAD",
    "git stash list",
    "git stash show -p",
    "git worktree list",
    "git branch --list",
    "git branch -a",
    "git bisect log",
    "git show HEAD",
    "git rev-parse --abbrev-ref HEAD",
    "git fetch origin",
    // Mutating, but scoped to this session's own work rather than the tree.
    "git add -A",
    "git commit -m 'fix the thing'",
    "git push origin feature/thing",
    "git tag v0.1.102",
    // Not git at all.
    "npm test",
    "pnpm build",
    "rg 'checkout' src/",
  ];
  for (const cmd of safe) {
    it(`ignores \`${cmd}\``, () => {
      expect(classifySharedTreeRisk(cmd)).toBeNull();
    });
  }

  it("ignores an empty or whitespace command", () => {
    expect(classifySharedTreeRisk("")).toBeNull();
    expect(classifySharedTreeRisk("   ")).toBeNull();
  });

  it("does not fire on help output for a risky verb", () => {
    expect(classifySharedTreeRisk("git checkout --help")).toBeNull();
    expect(classifySharedTreeRisk("git switch -h")).toBeNull();
  });

  it("over-matches a risky verb quoted inside another command, deliberately", () => {
    // Substring regexes can't tell a command from a string literal, and the
    // rest of `policy.ts` accepts the same imprecision (`BASH_HARD_DENY`
    // matches `echo "rm -rf /"` too). Pinned rather than fixed because the
    // trade only runs one way: a false positive costs one confirm the user
    // clicks through, a false negative reinstates the incident this guard
    // exists to prevent. Revisit only alongside real command parsing.
    expect(
      classifySharedTreeRisk("echo 'git checkout is a string here' > /tmp/notes.txt"),
    ).not.toBeNull();
  });
});

describe("describeSharedTreeRisk", () => {
  const risks: SharedTreeRisk[] = [
    "moves-head",
    "rewrites-history",
    "rewrites-worktree",
  ];
  it("gives every risk class a non-empty explanation", () => {
    for (const r of risks) {
      expect(describeSharedTreeRisk(r).length).toBeGreaterThan(0);
    }
  });
});
