/**
 * GET /api/skills?workDir=<absolute-path>
 *
 * Returns the Skills pane payload (ADR-0025): fingerprint summary,
 * suggestion list, user-global skill listing, project-local skill
 * listing, audit-decision status. Pure read — no CSRF guard needed.
 *
 * The Swift Skills pane calls this on:
 *   - tab open
 *   - explicit refresh button
 *   - after a `park-all` / `unpark` mutation completes
 *
 * The handler does no caching: every call re-walks both skill trees
 * and re-runs the fingerprint. Cheap on the order of a Files-pane
 * refresh; if it ever becomes expensive (huge `~/.claude/skills/`
 * tree), revisit with an in-process LRU keyed on `workDir`.
 */

import { type NextRequest, NextResponse } from "next/server";
import { CORE_SKILLS, computeActiveSkills } from "@marvin/runtime/skill-enablement";
import { validateProjectCwd } from "@marvin/runtime/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("workDir");
  // Verify the caller is targeting a registered project — see
  // `validateProjectCwd` for the contract. Belt-and-braces here:
  // the GET is a read-only response so the risk is "data leakage
  // about which paths exist", but uniform validation across the
  // route family is easier to reason about than a per-verb policy.
  const v = validateProjectCwd(raw);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  try {
    // ADR-0037 — compute the active set alongside the index so the pane
    // can render enable/disable state. `computeActiveSkills` builds the
    // index internally, so this is the same single walk as before.
    const { active, explicit, index } = computeActiveSkills(v.workDir);
    return NextResponse.json({
      ...index,
      enablement: { active, explicit, core: [...CORE_SKILLS] },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json(
      { error: `failed to build skills index: ${message}` },
      { status: 500 },
    );
  }
}
