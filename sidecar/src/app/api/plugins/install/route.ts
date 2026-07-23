/**
 * POST /api/plugins/install — install a full Claude Code plugin from a Git URL
 * into `~/.claude/plugins/` (ADR-0053 Phase 3).
 *
 * CSRF-guarded; user-initiated (the Plugins pane "Install from marketplace"
 * sheet). Clones the repo; if it's a marketplace with no `plugin` selection,
 * returns the plugin pick-list; otherwise copies the chosen plugin into the
 * plugin cache and registers it so the loader discovers it. Nothing from the
 * repo is executed at install.
 *
 * Body (JSON): { "url": "...", "plugin": "name"? }
 *          or  { "marketplace": "claude-plugins-official", "plugin": "name" }
 *              — install straight from a KNOWN marketplace's local catalog
 *              (relative-source plugins copy with no network at all).
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  installFromKnownMarketplace,
  installPluginFromGit,
} from "@marvin/runtime/plugin-installer";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

interface InstallBody {
  url?: string;
  plugin?: string;
  /** Known-marketplace flow: install `plugin` from this marketplace's local
   *  catalog instead of a pasted URL. */
  marketplace?: string;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: InstallBody;
  try {
    body = (await req.json()) as InstallBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const plugin = typeof body.plugin === "string" ? body.plugin.trim() : undefined;

  // Known-marketplace flow (catalog browse): no URL involved.
  const marketplace =
    typeof body.marketplace === "string" ? body.marketplace.trim() : "";
  if (marketplace) {
    if (!plugin) {
      return NextResponse.json(
        { error: "`plugin` is required with `marketplace`" },
        { status: 400 },
      );
    }
    const result = installFromKnownMarketplace({ marketplace, plugin });
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "install failed" }, { status: 400 });
    }
    return NextResponse.json(result);
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return NextResponse.json(
      { error: "`url` (or `marketplace` + `plugin`) is required" },
      { status: 400 },
    );
  }
  const result = installPluginFromGit({ url, ...(plugin ? { plugin } : {}) });

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "install failed" }, { status: 400 });
  }
  return NextResponse.json(result);
}
