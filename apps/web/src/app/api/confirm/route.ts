import { NextResponse, type NextRequest } from "next/server";

import { resolvePendingConfirm } from "@marvin/runtime/confirm-registry";

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

  const ok =
    decision === "allow"
      ? resolvePendingConfirm(turnId, toolUseId, {
          behavior: "allow",
          ...(body.updatedInput ? { updatedInput: body.updatedInput } : {}),
        })
      : resolvePendingConfirm(turnId, toolUseId, {
          behavior: "deny",
          message: body.message ?? "user denied the tool use",
          interrupt: false,
        });

  if (!ok) {
    return NextResponse.json(
      { error: "no pending confirm for that (turnId, toolUseId)" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, decision });
}
