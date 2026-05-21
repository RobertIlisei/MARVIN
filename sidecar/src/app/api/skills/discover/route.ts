/**
 * POST /api/skills/discover
 *
 * Body: { workDir }
 *
 * Runs the LLM-driven project-skill discoverer (ADR-0028, development
 * branch). One Claude call with project fingerprint + structure +
 * memory + recent commits. Returns 2-4 project-local skill suggestions
 * and caches them at <workDir>/.marvin/discovered-skills.json. The
 * Skills pane then surfaces the cached suggestions on subsequent
 * /api/skills calls (no extra LLM cost).
 *
 * On-demand only — the Skills pane "Discover" button triggers this.
 * Never auto-fires on session start. Real LLM cost per call (~1-2¢
 * with Sonnet).
 */

import { type NextRequest, NextResponse } from "next/server";

import { requireMarvinClient } from "@/lib/csrf";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { discoverProjectSkills } from "@marvin/runtime/project-skill-discoverer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discovery can do real work (LLM call, git log) — allow up to 60s.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { workDir?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const v = validateProjectCwd(body.workDir);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  try {
    const payload = await discoverProjectSkills(v.workDir);
    return NextResponse.json(payload);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { error: `discovery failed: ${message}` },
      { status: 500 },
    );
  }
}
