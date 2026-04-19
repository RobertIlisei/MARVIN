import { NextResponse, type NextRequest } from "next/server";

import { cancelLiveTurn } from "@marvin/runtime/turn-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/chat/cancel { marvinSessionId }
 *
 * Explicit user cancel. Aborts the in-flight SDK turn via its
 * `AbortController`. Separate from the SSE body close so a refreshed
 * browser tab doesn't kill the agent by accident.
 */
export async function POST(req: NextRequest) {
  let body: { marvinSessionId?: string };
  try {
    body = (await req.json()) as { marvinSessionId?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const id = body.marvinSessionId?.trim();
  if (!id) {
    return NextResponse.json(
      { error: "marvinSessionId is required" },
      { status: 400 },
    );
  }
  const cancelled = cancelLiveTurn(id);
  return NextResponse.json({ cancelled });
}
