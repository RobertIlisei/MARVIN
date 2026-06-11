/**
 * POST /api/skills/enable — set the project's active skill set (ADR-0037).
 *
 * Writes `<workDir>/.marvin/skills.json` with the user's chosen enabled
 * skills. CSRF-guarded (mutates the project workspace). The next turn's
 * system prompt names this set and tells the model to ignore the rest.
 *
 * Body (JSON):
 * ```
 * { "workDir": "/abs/path", "enabled": ["graphify", "claude-api", ...] }
 * ```
 */

import { type NextRequest, NextResponse } from "next/server";
import { computeActiveSkills, setEnabledSkills } from "@marvin/runtime/skill-enablement";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

interface EnableBody {
  workDir?: string;
  enabled?: string[];
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: EnableBody;
  try {
    body = (await req.json()) as EnableBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const v = validateProjectCwd(body.workDir);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  if (!Array.isArray(body.enabled)) {
    return NextResponse.json({ error: "`enabled` must be an array of skill names" }, { status: 400 });
  }

  const enabled = body.enabled.filter((x): x is string => typeof x === "string");
  setEnabledSkills(v.workDir, enabled);

  // Echo back the recomputed active set so the client doesn't need a
  // second round-trip to refresh.
  const { active, explicit } = computeActiveSkills(v.workDir);
  return NextResponse.json({ ok: true, active, explicit });
}
