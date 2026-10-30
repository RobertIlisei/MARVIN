/**
 * PUT /api/sessions/posture — change a tab's posture without sending a turn
 * (ADR-0127 §9, ADR-0108 amendment; milestone 2).
 *
 * Body: `{ projectId, marvinSessionId, posture: { model?, thinkingMode?,
 * permissionStrategy?, mode? }, actor?: "user" | "supervisor", grounds? }`.
 *
 * The meta is written with a revision and a source; the chat route keeps the
 * fields set here over what the app posts until the app sends the revision
 * back. A narrowing reaches a live turn at its next tool call; a model or
 * effort change applies from the next turn.
 *
 * Only narrowing is accepted, for either actor: a widening answers 409 with
 * `widened` naming the dimensions, and changes nothing. Until the app shows an
 * API-set posture (plan milestone 6) a widening here would run a tab wider
 * than its toolbar says.
 *
 * CSRF-guarded. `actor: "supervisor"` (the external prototype opting into the
 * supervisor's policy and ledger) also needs the per-boot capability token,
 * and is ledgered — a narrowing as a performed act, a widening as an
 * escalation.
 */

import { activeModelLookup, applyPostureChange, validatePosturePatch } from "@marvin/runtime/posture";
import type { LedgerGround } from "@marvin/runtime/supervisor-ledger";
import { SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const GROUND_KINDS = new Set(["plan", "dod", "adr", "memory", "charter", "file"]);

export async function PUT(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const marvinSessionId = typeof body.marvinSessionId === "string" ? body.marvinSessionId.trim() : "";
  if (!projectId || !marvinSessionId) return NextResponse.json({ error: "projectId and marvinSessionId are required" }, { status: 400 });

  const actor = body.actor === undefined ? "user" : body.actor;
  if (actor !== "user" && actor !== "supervisor") return NextResponse.json({ error: 'actor must be "user" or "supervisor"' }, { status: 400 });
  if (actor === "supervisor" && !verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) {
    return NextResponse.json({ error: "the supervisor actor needs the per-boot capability token (ADR-0127 §5)" }, { status: 403 });
  }

  const valid = validatePosturePatch(body.posture);
  if (!valid.ok) return NextResponse.json({ error: valid.error }, { status: 400 });

  // Grounds are recorded as given; the route cannot resolve them without the tab's context.
  const grounds: LedgerGround[] = Array.isArray(body.grounds)
    ? body.grounds
        .filter((g): g is { kind: string; ref: string } => !!g && typeof g === "object" && GROUND_KINDS.has((g as { kind?: string }).kind ?? "") && typeof (g as { ref?: unknown }).ref === "string")
        .slice(0, 10)
        .map((g) => ({ kind: g.kind as LedgerGround["kind"], ref: g.ref.slice(0, 500), provenance: "unresolved" as const }))
    : [];

  const result = applyPostureChange({
    projectId,
    marvinSessionId,
    patch: valid.patch,
    actor,
    lookup: await activeModelLookup(),
    ...(actor === "supervisor" ? { ledger: { mode: "autonomous" as const, grounds } } : {}),
  });
  if (!result.ok) {
    const widened = result.changes?.filter((c) => c.direction === "widen").map((c) => c.field);
    return NextResponse.json(
      { error: result.error, ...(result.changes ? { changes: result.changes } : {}), ...(widened?.length ? { widened } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({
    posture: result.meta.posture,
    postureRevision: result.meta.postureRevision,
    postureSource: result.meta.postureSource,
    changes: result.changes,
    liveApplied: result.liveApplied,
  });
}
