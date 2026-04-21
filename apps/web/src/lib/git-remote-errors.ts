/**
 * Shared stderr classifier for the three remote routes (push / pull
 * / fetch). Maps well-known git-network error messages onto stable
 * error codes plus a one-line remedy the banner can surface.
 *
 * All three routes share this because the failure taxonomy is
 * identical — auth, network, non-fast-forward, no-remote.
 *
 * See [ADR-0013](../../../docs/decisions/0013-git-remote-ops-and-credentials.md).
 */

import { NextResponse } from "next/server";

export type RemoteErrorCode =
  | "auth-publickey"
  | "auth-failed"
  | "network"
  | "non-fast-forward"
  | "no-upstream"
  | "no-remote"
  | "merge-conflict"
  | "git-failed";

export function classifyRemoteStderr(stderr: string): {
  code: RemoteErrorCode;
  remedy: string;
  httpStatus: number;
} {
  const lower = stderr.toLowerCase();

  if (lower.includes("permission denied (publickey)")) {
    return {
      code: "auth-publickey",
      remedy:
        "check your SSH key is loaded (`ssh-add -l`) and authorised for the remote",
      httpStatus: 502,
    };
  }
  if (
    lower.includes("could not read username") ||
    lower.includes("authentication failed") ||
    lower.includes("invalid credentials") ||
    lower.includes("support for password authentication")
  ) {
    return {
      code: "auth-failed",
      remedy:
        "configure a git credential helper (osxkeychain / gh auth / 1password-cli)",
      httpStatus: 502,
    };
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("network is unreachable") ||
    lower.includes("connection refused") ||
    lower.includes("connection timed out")
  ) {
    return {
      code: "network",
      remedy: "check network connectivity to the remote host",
      httpStatus: 502,
    };
  }
  if (lower.includes("rejected") || lower.includes("non-fast-forward")) {
    return {
      code: "non-fast-forward",
      remedy:
        "pull first, or push with --force-with-lease if you truly need to overwrite",
      httpStatus: 409,
    };
  }
  if (lower.includes("no upstream")) {
    return {
      code: "no-upstream",
      remedy:
        "set an upstream with `git push -u <remote> <branch>` in the terminal",
      httpStatus: 409,
    };
  }
  if (lower.includes("does not appear to be a git repository")) {
    return {
      code: "no-remote",
      remedy: "check the remote URL or run `git remote -v`",
      httpStatus: 502,
    };
  }
  if (
    lower.includes("conflict") &&
    (lower.includes("merge") || lower.includes("automatic"))
  ) {
    return {
      code: "merge-conflict",
      remedy:
        "resolve the conflicts in the editor, stage the fix, and commit (or run `git merge --abort` to back out)",
      httpStatus: 409,
    };
  }
  return {
    code: "git-failed",
    remedy: "inspect the stderr below for details",
    httpStatus: 502,
  };
}

export function remoteErrorResponse(stderr: string): NextResponse {
  const classified = classifyRemoteStderr(stderr);
  return NextResponse.json(
    {
      error: classified.code,
      stderr,
      remedy: classified.remedy,
    },
    { status: classified.httpStatus },
  );
}
