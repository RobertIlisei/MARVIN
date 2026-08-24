/**
 * POST /api/plugins/update — pull the latest version of installed plugins
 * (ADR-0071).
 *
 * The install path (ADR-0053 Phase 3) clones a marketplace or plugin repo and
 * copies it into the plugin cache, but recorded no source, so "update" was
 * impossible. Provenance now lives in MARVIN's own data dir (deliberately NOT
 * in the co-owned `installed_plugins.json` — see `install-provenance.ts`), and
 * this route acts on it.
 *
 * CSRF-guarded; user-initiated (the Plugins pane "Check for updates" /
 * per-row "Update"). Plugins installed through the Claude Code `/plugin` UI
 * carry no MARVIN provenance and are skipped by the bulk path — they aren't
 * ours to update.
 *
 * Body (JSON):
 * ```
 * { "key": "honeycomb@claude-plugins-official", "checkOnly": true?, "url": "..."? }
 * { "all": true, "checkOnly": true? }
 * ```
 */

import { updateAllPlugins, updatePlugin } from "@marvin/runtime/plugin-installer";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

interface UpdateBody {
  key?: string;
  url?: string;
  checkOnly?: boolean;
  all?: boolean;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: UpdateBody;
  try {
    body = (await req.json()) as UpdateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const checkOnly = body.checkOnly === true;
  const url = typeof body.url === "string" && body.url.trim() ? body.url.trim() : undefined;

  if (body.all === true) {
    if (url) {
      return NextResponse.json(
        { error: "`url` cannot be combined with `all` — rebind one plugin at a time." },
        { status: 400 },
      );
    }
    return NextResponse.json(updateAllPlugins({ ...(checkOnly ? { checkOnly: true } : {}) }));
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return NextResponse.json({ error: "`key` (or `all: true`) is required" }, { status: 400 });
  }

  const outcome = updatePlugin({
    key,
    ...(url ? { url } : {}),
    ...(checkOnly ? { checkOnly: true } : {}),
  });
  return NextResponse.json({ ok: outcome.status !== "error", results: [outcome] });
}
