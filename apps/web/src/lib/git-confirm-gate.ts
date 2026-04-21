/**
 * Shared confirm-token dance for `/api/git/*` mutation routes.
 *
 * Every mutation route looks like:
 *   1. Parse the request body.
 *   2. `checkFsPath` the cwd.
 *   3. Build a structural `GitOp` matching what's about to run.
 *   4. `confirmGate(req, op, cwd)` — returns either `{ ok: true }` or
 *      a response to return verbatim (deny / needs-confirm / token
 *      mismatch).
 *   5. Execute via `runGit`.
 *
 * This helper covers step 4. cwd sandboxing stays inline in each
 * route so REVIEW.md's "paired with `checkFsPath`" guarantee is
 * visibly satisfied on a file-by-file audit.
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import {
  consumeGitConfirmToken,
  type GitOp,
  gitWritePolicy,
} from "@marvin/git";
import { type NextRequest, NextResponse } from "next/server";

export type ConfirmGateOutcome =
  | { allow: true }
  | { allow: false; response: NextResponse };

export function confirmGate(
  req: NextRequest,
  op: GitOp,
  cwd: string,
): ConfirmGateOutcome {
  const decision = gitWritePolicy(op);

  if (decision.class === "deny") {
    return {
      allow: false,
      response: NextResponse.json(
        { error: "policy-deny", reason: decision.reason, op },
        { status: 403 },
      ),
    };
  }

  if (decision.class === "auto") {
    return { allow: true };
  }

  // decision.class === "confirm" — require a token.
  const token = req.headers.get("x-marvin-confirmed");
  if (!token) {
    return {
      allow: false,
      response: NextResponse.json(
        {
          error: "needs-confirm",
          severity: decision.severity ?? "warn",
          reason: decision.reason,
          op,
        },
        { status: 409 },
      ),
    };
  }

  const consumed = consumeGitConfirmToken(token, { op, cwd });
  if (!consumed.ok) {
    return {
      allow: false,
      response: NextResponse.json(
        { error: "token-rejected", reason: consumed.reason },
        { status: 409 },
      ),
    };
  }
  return { allow: true };
}
