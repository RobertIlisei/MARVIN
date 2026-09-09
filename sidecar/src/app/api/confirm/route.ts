import {
  getPendingOriginalInput,
  resolvePendingConfirm,
} from "@marvin/runtime/confirm-registry";
import { appendSessionTurn } from "@marvin/runtime/session";
import { announceProjectEvent, getLiveTurnByTurnId } from "@marvin/runtime/turn-registry";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ConfirmBody = {
  turnId?: string;
  toolUseId?: string;
  decision?: "allow" | "deny";
  /** Optional free-text shown back to the model when denying. */
  message?: string;
  /** Optional replacement for the tool input (e.g. user edited the diff). */
  updatedInput?: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const turnId = body.turnId?.trim();
  const toolUseId = body.toolUseId?.trim();
  const decision = body.decision;
  if (!turnId || !toolUseId || (decision !== "allow" && decision !== "deny")) {
    return NextResponse.json(
      { error: "turnId, toolUseId, and decision ('allow'|'deny') are required" },
      { status: 400 },
    );
  }

  let ok: boolean;
  if (decision === "allow") {
    // The SDK's PermissionResult zod schema rejects an `allow` reply that
    // omits `updatedInput`. Prefer the client-supplied edit; otherwise fall
    // back to the original input the SDK handed us when the tool was first
    // proposed; as a last resort, an empty object — never undefined.
    const original = getPendingOriginalInput(turnId, toolUseId) ?? {};
    const updatedInput: Record<string, unknown> =
      body.updatedInput && typeof body.updatedInput === "object" && !Array.isArray(body.updatedInput)
        ? body.updatedInput
        : original;
    ok = resolvePendingConfirm(turnId, toolUseId, {
      behavior: "allow",
      updatedInput,
    });
  } else {
    ok = resolvePendingConfirm(turnId, toolUseId, {
      behavior: "deny",
      message:
        typeof body.message === "string" && body.message.trim().length > 0
          ? body.message
          : "user denied the tool use",
      interrupt: false,
    });
  }

  if (!ok) {
    return NextResponse.json(
      { error: "no pending confirm for that (turnId, toolUseId)" },
      { status: 404 },
    );
  }
  // ADR-0107 — clear the "needs you" signal on every watcher, not just the
  // tab that answered.
  const owner = getLiveTurnByTurnId(turnId);
  if (owner) {
    // Record what was decided, beside the `confirm.request` that asked.
    //
    // `confirm.decision` has been a declared transcript event since the
    // confirm gate shipped and **nothing has ever written one** — 0 records
    // across every transcript of a real project, against 14 requests in a
    // single evening. The consequence showed up the moment it was needed: the
    // user asked whether background sessions were really working, and the
    // transcripts could say a question had been ASKED but not whether it was
    // ever answered, nor how long it waited. A half-written pair is worse than
    // no pair, because it reads as an answer.
    //
    // Written before the announce so a crash between the two loses the
    // notification rather than the record. Failure here must not fail the
    // decision: the tool call is already resolved and the turn is moving.
    try {
      appendSessionTurn(owner.projectId, owner.marvinSessionId, {
        type: "confirm.decision",
        at: new Date().toISOString(),
        turnId,
        toolUseId,
        decision,
        ...(decision === "deny" && typeof body.message === "string" && body.message.trim()
          ? { message: body.message.trim().slice(0, 500) }
          : {}),
      });
    } catch {
      /* the decision stands; only the record is lost */
    }
    announceProjectEvent({
      event: "confirm.resolved",
      data: { marvinSessionId: owner.marvinSessionId, projectId: owner.projectId, turnId, toolUseId, decision },
    });
  }
  return NextResponse.json({ ok: true, decision });
}
