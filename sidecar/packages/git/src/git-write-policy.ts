/**
 * Policy for user-initiated git operations from the Source Control
 * panel.
 *
 * Third sibling of `packages/tools/src/policy.ts` (LLM tool channel)
 * and `packages/tools/src/fs-write-policy.ts` (user filesystem
 * channel). Same shape (auto/confirm/deny), different input space —
 * git ops are neither file writes nor tool calls.
 *
 * The classifier is pure. Every route that mutates git state runs
 * `gitWritePolicy(op, ctx)` before touching the tree; `confirm`
 * decisions round-trip through `git-write-confirm-registry` before
 * execution.
 *
 * See [ADR-0012](../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafeRef, isSafeRemote } from "./argv-guards";

export type GitOp =
  | { kind: "stage"; paths: string[] }
  | { kind: "unstage"; paths: string[] }
  | {
      kind: "discard";
      paths: string[];
      /**
       * `staged` unstages, `working` overwrites uncommitted edits, and
       * `untracked` DELETES files git has never seen — the one mode with
       * no reflog behind it. VS Code's "Discard all changes" is really
       * `working` + `untracked` together; the panel issues two calls so
       * each gets its own decision.
       */
      mode: "working" | "staged" | "untracked";
    }
  | {
      kind: "commit";
      message: string;
      amend: boolean;
      /** `true` if HEAD has already been pushed to its upstream. */
      hasPushedHead: boolean;
    }
  | { kind: "branch-create"; name: string; from: string }
  | {
      kind: "branch-switch";
      name: string;
      /** `true` when the working tree + index are both clean. */
      workingTreeClean: boolean;
      /** `git switch --detach` — leaves HEAD off any branch. */
      detach?: boolean;
    }
  | {
      kind: "branch-delete";
      name: string;
      merged: boolean;
      isCurrent: boolean;
    }
  // M5 ops — policy encoded here even though routes land later.
  | {
      kind: "push";
      /** `none` = regular push; `with-lease` = --force-with-lease; `plain` = --force. */
      force: "none" | "with-lease" | "plain";
      branch: string;
      /**
       * Commits on the upstream not yet in local — surfacing "upstream
       * has N commits you don't" lets us `confirm warn` even on a
       * non-force push.
       */
      upstreamAhead: number;
      /** `git push -u` — publishes a branch that has no upstream yet. */
      setUpstream?: boolean;
    }
  | { kind: "pull"; strategy: "ff-only" | "rebase" | "merge" }
  | { kind: "fetch"; remote: string }
  | {
      kind: "stash";
      action: "push" | "pop" | "apply" | "drop";
      /** Stash entries present when the op was classified. */
      entryCount: number;
    };

export type GitWriteClass = "auto" | "confirm" | "deny";
export type GitWriteSeverity = "warn" | "danger";

export interface GitWriteDecision {
  class: GitWriteClass;
  reason: string;
  /** Only populated when `class === "confirm"`. */
  severity?: GitWriteSeverity;
}

const auto = (reason: string): GitWriteDecision => ({ class: "auto", reason });
const deny = (reason: string): GitWriteDecision => ({ class: "deny", reason });
const confirm = (
  reason: string,
  severity: GitWriteSeverity,
): GitWriteDecision => ({ class: "confirm", reason, severity });

/**
 * Classify a user-initiated git op. Callers are expected to have
 * already:
 *   - sandboxed `cwd` via `checkFsPath`
 *   - guard-whitelisted every ref / remote / path they received from
 *     the UI via `argv-guards.ts`
 *
 * This function re-runs the ref / remote whitelist for defence in
 * depth — missing a guard at a route is one more reason for the
 * policy to reject rather than a reason for it to trust blindly.
 */
export function gitWritePolicy(op: GitOp): GitWriteDecision {
  switch (op.kind) {
    case "stage": {
      if (op.paths.length === 0) return deny("stage: empty path list");
      return auto("stage adds to the index; reversible via unstage");
    }
    case "unstage": {
      if (op.paths.length === 0) return deny("unstage: empty path list");
      return auto("unstage removes from the index; working tree unchanged");
    }
    case "discard": {
      if (op.paths.length === 0) return deny("discard: empty path list");
      if (op.mode === "staged") {
        return auto(
          "discard --staged moves changes back to the working tree; reversible",
        );
      }
      if (op.mode === "untracked") {
        // `git clean` on files git has never hashed. There is no reflog
        // entry, no object in the store, nothing to recover from — the
        // only mode in this file whose consequence is unconditional.
        return confirm(
          `deleting ${op.paths.length} untracked file(s) is permanent — git has no copy of them`,
          "danger",
        );
      }
      // mode === "working" — destroys unstaged edits.
      return confirm(
        `discarding working-tree changes to ${op.paths.length} file(s) is not recoverable without a reflog`,
        "warn",
      );
    }
    case "commit": {
      if (op.message.trim().length === 0 && !op.amend) {
        return deny("commit: empty message");
      }
      if (op.amend && op.hasPushedHead) {
        return confirm(
          "amending a commit that has already been pushed rewrites shared history",
          "danger",
        );
      }
      return auto("commit is reversible via `git reset HEAD@{1}`");
    }
    case "branch-create": {
      if (!isSafeRef(op.name)) {
        return deny(`branch-create: invalid branch name \`${op.name}\``);
      }
      if (!isSafeRef(op.from)) {
        return deny(`branch-create: invalid source ref \`${op.from}\``);
      }
      return auto("branch-create is reversible via branch-delete");
    }
    case "branch-switch": {
      if (!isSafeRef(op.name)) {
        return deny(`branch-switch: invalid branch name \`${op.name}\``);
      }
      if (!op.workingTreeClean) {
        // Still a hard-deny, but the panel now has a stash op to offer
        // as the remedy instead of leaving the user at a dead end.
        return deny(
          "branch-switch: working tree is dirty; commit, stash or discard changes first",
        );
      }
      if (op.detach) {
        // Detached HEAD is recoverable (the branch ref never moved) but
        // it is a state users land in by accident and then commit into,
        // so it is worth one deliberate click.
        return confirm(
          `checking out \`${op.name}\` detached leaves HEAD off any branch — new commits there are unreachable once you switch away`,
          "warn",
        );
      }
      return auto("branch-switch on a clean tree is reversible");
    }
    case "branch-delete": {
      if (!isSafeRef(op.name)) {
        return deny(`branch-delete: invalid branch name \`${op.name}\``);
      }
      if (op.isCurrent) {
        return deny("branch-delete: cannot delete the current branch");
      }
      if (!op.merged) {
        return confirm(
          `branch \`${op.name}\` has unmerged commits that will be unreachable without a reflog`,
          "danger",
        );
      }
      return auto("branch-delete of a merged branch is safe");
    }
    case "push": {
      if (!isSafeRef(op.branch)) {
        return deny(`push: invalid branch name \`${op.branch}\``);
      }
      if (op.force === "plain") {
        // Non-negotiable. Users who need this go to the terminal.
        return deny(
          "push --force is not available from the panel; use the terminal if you truly need it",
        );
      }
      if (op.force === "with-lease") {
        return confirm(
          "push --force-with-lease rewrites the remote branch if the lease matches",
          "danger",
        );
      }
      if (op.upstreamAhead > 0) {
        return confirm(
          `upstream is ahead by ${op.upstreamAhead} commit(s); a regular push will fail — pull first`,
          "warn",
        );
      }
      return auto("push is a remote read/write; no local data loss");
    }
    case "pull": {
      if (op.strategy === "ff-only") {
        return auto("pull --ff-only fails cleanly on divergence; safe default");
      }
      if (op.strategy === "rebase") {
        return confirm(
          "pull --rebase rewrites local commits on top of upstream",
          "warn",
        );
      }
      return confirm(
        "pull --merge creates a merge commit; confirm the strategy",
        "warn",
      );
    }
    case "fetch": {
      if (!isSafeRemote(op.remote)) {
        return deny(`fetch: invalid remote name \`${op.remote}\``);
      }
      return auto("fetch is read-only on local refs");
    }
    case "stash": {
      if (op.action === "push") {
        return auto("stash push is reversible via stash pop");
      }
      if (op.entryCount === 0) {
        return deny(`stash ${op.action}: no stash entries`);
      }
      if (op.action === "drop") {
        return confirm(
          "dropping a stash entry discards it; recovery needs a dangling-commit hunt",
          "danger",
        );
      }
      // pop / apply — replays the stash onto the working tree. Can
      // conflict, but nothing is lost: `apply` keeps the entry, and a
      // conflicting `pop` leaves it in place too.
      return auto(`stash ${op.action} restores changes into the working tree`);
    }
  }
}
