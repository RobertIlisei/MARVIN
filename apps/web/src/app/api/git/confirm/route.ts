/**
 * POST /api/git/confirm — body `{ op: GitOp, cwd: string }`
 *
 * Mints a one-shot token for an op that `gitWritePolicy` classified
 * as `confirm`. Returns `{ token, expiresIn: 60 }`. The client
 * replays the original mutation request with `X-Marvin-Confirmed:
 * <token>` to complete.
 *
 * The confirm registry is structural — when the downstream route
 * consumes the token, it passes the op it's about to execute. If
 * the stored op doesn't match, the token is rejected. That prevents
 * the "mint token for harmless op, replay with dangerous op"
 * pattern.
 *
 * This route refuses to mint for `auto` (no point; waste of a token)
 * or `deny` (the op would fail anyway) classifications — saves a
 * confused-looking token round-trip when a client mis-targets this
 * route.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import {
  type GitOp,
  gitWritePolicy,
  mintGitConfirmToken,
} from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { op?: unknown; cwd?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const op = parseGitOp(body.op);
  if (!cwd || !op) {
    return NextResponse.json(
      { error: "cwd and a valid op required" },
      { status: 400 },
    );
  }

  const sandbox = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!sandbox.ok || !sandbox.isDirectory) {
    return NextResponse.json(
      { error: sandbox.ok ? "cwd is not a directory" : sandbox.error },
      { status: 400 },
    );
  }
  const root = sandbox.absolutePath;

  const decision = gitWritePolicy(op);
  if (decision.class !== "confirm") {
    return NextResponse.json(
      {
        error: decision.class === "deny" ? "policy-deny" : "policy-auto",
        reason: decision.reason,
      },
      { status: decision.class === "deny" ? 403 : 400 },
    );
  }

  const minted = mintGitConfirmToken(op, root);
  return NextResponse.json({
    token: minted.token,
    expiresIn: minted.expiresIn,
    severity: decision.severity,
    reason: decision.reason,
  });
}

/**
 * Strict structural validator for `GitOp`. Returns the parsed op on
 * success, `null` on any mismatch. Keeping this inline rather than a
 * zod dep since the shape is small and audit-visible here.
 */
function parseGitOp(raw: unknown): GitOp | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "stage":
    case "unstage": {
      if (!isStringArray(r.paths) || r.paths.length === 0) return null;
      return { kind: r.kind, paths: r.paths };
    }
    case "discard": {
      if (!isStringArray(r.paths) || r.paths.length === 0) return null;
      if (r.mode !== "working" && r.mode !== "staged") return null;
      return { kind: "discard", paths: r.paths, mode: r.mode };
    }
    case "commit": {
      if (typeof r.message !== "string") return null;
      if (typeof r.amend !== "boolean") return null;
      if (typeof r.hasPushedHead !== "boolean") return null;
      return {
        kind: "commit",
        message: r.message,
        amend: r.amend,
        hasPushedHead: r.hasPushedHead,
      };
    }
    case "branch-create": {
      if (typeof r.name !== "string" || typeof r.from !== "string") return null;
      return { kind: "branch-create", name: r.name, from: r.from };
    }
    case "branch-switch": {
      if (typeof r.name !== "string") return null;
      if (typeof r.workingTreeClean !== "boolean") return null;
      return {
        kind: "branch-switch",
        name: r.name,
        workingTreeClean: r.workingTreeClean,
      };
    }
    case "branch-delete": {
      if (typeof r.name !== "string") return null;
      if (typeof r.merged !== "boolean") return null;
      if (typeof r.isCurrent !== "boolean") return null;
      return {
        kind: "branch-delete",
        name: r.name,
        merged: r.merged,
        isCurrent: r.isCurrent,
      };
    }
    case "push": {
      if (typeof r.branch !== "string") return null;
      if (r.force !== "none" && r.force !== "with-lease" && r.force !== "plain") {
        return null;
      }
      if (typeof r.upstreamAhead !== "number") return null;
      return {
        kind: "push",
        branch: r.branch,
        force: r.force,
        upstreamAhead: r.upstreamAhead,
      };
    }
    case "pull": {
      if (r.strategy !== "ff-only" && r.strategy !== "rebase" && r.strategy !== "merge") {
        return null;
      }
      return { kind: "pull", strategy: r.strategy };
    }
    case "fetch": {
      if (typeof r.remote !== "string") return null;
      return { kind: "fetch", remote: r.remote };
    }
    default:
      return null;
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
