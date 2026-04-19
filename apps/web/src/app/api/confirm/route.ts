import { NextResponse, type NextRequest } from "next/server";

import {
  getPendingOriginalInput,
  resolvePendingConfirm,
} from "@marvin/runtime/confirm-registry";

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
  return NextResponse.json({ ok: true, decision });
}
