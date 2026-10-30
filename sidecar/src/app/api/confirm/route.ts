import { normalizeSheetAnswer, recordConfirmDecision } from "@marvin/runtime/confirm-answer";
import {
  getPendingConfirm,
  getPendingOriginalInput,
  resolvePendingConfirm,
} from "@marvin/runtime/confirm-registry";
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
    let updatedInput: Record<string, unknown> =
      body.updatedInput && typeof body.updatedInput === "object" && !Array.isArray(body.updatedInput)
        ? body.updatedInput
        : original;
    // ADR-0127 §9 — an allow on a question must carry an answer. It used to
    // resolve with the original input and nothing chosen; the sheet's own
    // `{ answers, questions }` passes, and `questions` comes from the registry.
    if (getPendingConfirm(turnId, toolUseId)?.raisedBy === "ask-user-question") {
      const answered = normalizeSheetAnswer(original, body.updatedInput);
      if (!answered.ok) return NextResponse.json({ error: answered.error }, { status: 400 });
      updatedInput = answered.updatedInput;
    }
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
  // tab that answered — and record what was decided and by whom (ADR-0127)
  // beside the `confirm.request` that asked. `confirm.decision` was declared
  // when the confirm gate shipped and nothing wrote one for months: a
  // half-written pair reads as an answer.
  recordConfirmDecision({
    turnId,
    toolUseId,
    decision,
    answeredBy: "user",
    ...(decision === "deny" && typeof body.message === "string" && body.message.trim() ? { message: body.message.trim() } : {}),
  });
  return NextResponse.json({ ok: true, decision });
}
