/**
 * POST   /api/skills/park   → write `<workDir>/.marvin/skills.md`
 * DELETE /api/skills/park   → remove the file
 *
 * The audit-decision write loop for the Skills pane (ADR-0025).
 * Both verbs are CSRF-guarded — they mutate the project workspace.
 *
 * POST body shape (JSON):
 * ```
 * {
 *   "workDir": "/abs/path/to/project",
 *   "note": "optional one-line note",
 *   "parkedNames": ["webapp-testing", "playwright-golden-path"]
 * }
 * ```
 *
 * The written content is one line — for example:
 *   "audited 2026-05-11 (parked: webapp-testing, pdf) — moving on"
 *
 * That's all `personality.ts`'s audit-pending block needs to flip
 * the audit-decided signal. Future versions can write richer
 * structured content (per-skill rejection reasons), but v1 keeps
 * the contract minimal so the firm-surface check stays trivial.
 */

import { type NextRequest, NextResponse } from "next/server";
import { resolve } from "node:path";
import {
  clearSkillsAuditDecision,
  writeSkillsAuditDecision,
} from "@marvin/runtime/skills-index";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

interface ParkBody {
  workDir?: string;
  note?: string;
  parkedNames?: string[];
}

function validateWorkDir(raw: unknown): { ok: true; workDir: string } | { ok: false; status: number; error: string } {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, status: 400, error: "workDir is required" };
  }
  if (!raw.startsWith("/")) {
    return { ok: false, status: 400, error: "workDir must be an absolute path" };
  }
  return { ok: true, workDir: resolve(raw) };
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: ParkBody;
  try {
    body = (await req.json()) as ParkBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const v = validateWorkDir(body.workDir);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const note = typeof body.note === "string" && body.note.length > 0 && body.note.length < 500
    ? body.note
    : undefined;
  const parkedNames = Array.isArray(body.parkedNames)
    ? body.parkedNames.filter((s): s is string => typeof s === "string").slice(0, 50)
    : undefined;

  const result = writeSkillsAuditDecision(v.workDir, { note, parkedNames });
  return NextResponse.json({ ok: true, ...result });
}

export async function DELETE(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const raw = req.nextUrl.searchParams.get("workDir");
  const v = validateWorkDir(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });

  const result = clearSkillsAuditDecision(v.workDir);
  return NextResponse.json({ ok: true, ...result });
}
