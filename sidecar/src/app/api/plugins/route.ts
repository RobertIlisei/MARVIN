/**
 * Plugins API (ADR-0053 Phase 2) — the read/toggle surface behind the Plugins
 * pane.
 *
 * - GET  /api/plugins?workDir=/abs/path
 *     Lists installed Claude Code plugins (from ~/.claude/plugins) with a
 *     contribution summary and per-project enabled state, PLUS the browseable
 *     `catalog` of every known marketplace's plugins (local clones — no
 *     network), each marked installed/not.
 * - POST /api/plugins  { workDir, enabled: [...] }
 *     Sets the project's active plugin set — writes
 *     `<workDir>/.marvin/plugins.json`. Next turn loads them (skills + commands
 *     + gated MCP; agents/hooks deferred). CSRF-guarded (mutates the workspace).
 */

import { type NextRequest, NextResponse } from "next/server";
import { listMarketplaceCatalog } from "@marvin/runtime/plugin-installer";
import {
  listInstalledPlugins,
  setEnabledPlugins,
} from "@marvin/runtime/plugin-loader";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export async function GET(req: NextRequest) {
  const workDir = new URL(req.url).searchParams.get("workDir")?.trim();
  const v = validateProjectCwd(workDir);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  return NextResponse.json({
    plugins: listInstalledPlugins(v.workDir),
    catalog: listMarketplaceCatalog(),
  });
}

interface ToggleBody {
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

  let body: ToggleBody;
  try {
    body = (await req.json()) as ToggleBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const v = validateProjectCwd(body.workDir);
  if (!v.ok) {
    return NextResponse.json({ error: v.error }, { status: v.status });
  }
  if (!Array.isArray(body.enabled)) {
    return NextResponse.json(
      { error: "`enabled` must be an array of plugin names" },
      { status: 400 },
    );
  }

  const enabled = body.enabled.filter((x): x is string => typeof x === "string");
  setEnabledPlugins(v.workDir, enabled);

  // Echo the refreshed list so the client doesn't need a second round-trip.
  return NextResponse.json({ ok: true, plugins: listInstalledPlugins(v.workDir) });
}
