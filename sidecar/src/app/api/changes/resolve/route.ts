/**
 * POST /api/changes/resolve — accept or reject agent edits (ADR-0034).
 *
 * Body: {
 *   cwd, marvinSessionId, [projectId],
 *   action: "accept" | "reject",
 *   [path],        — omit for ALL files
 *   [hunkIndex],   — with `path`: operate on one hunk of this file
 * }
 *
 * Semantics (see change-checkpoints.ts):
 *   accept hunk/file/all — keep the disk content, advance/drop baselines
 *   reject hunk          — reverse-apply that hunk to the file on disk
 *   reject file/all      — restore the pre-agent baseline (added → delete)
 *
 * One endpoint rather than four: accept/reject are the same shape with a
 * verb, and the native client wants a single call site. CSRF-guarded like
 * every mutating route.
 */

import {
  acceptAll,
  acceptFile,
  acceptHunk,
  rejectAll,
  rejectFile,
  rejectHunk,
} from "@marvin/runtime/change-checkpoints";
import { type NextRequest, NextResponse } from "next/server";
import { resolveChangesKey } from "@/lib/changes-helpers";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResolveBody {
  cwd?: string;
  marvinSessionId?: string;
  projectId?: string;
  action?: string;
  path?: string;
  hunkIndex?: number;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: ResolveBody;
  try {
    body = (await req.json()) as ResolveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const resolved = resolveChangesKey(body);
  if ("error" in resolved) return resolved.error;
  const { key } = resolved;

  const action = body.action;
  if (action !== "accept" && action !== "reject") {
    return NextResponse.json(
      { error: 'action must be "accept" or "reject"' },
      { status: 400 },
    );
  }
  const path = body.path?.trim();
  const hunkIndex = body.hunkIndex;

  if (hunkIndex !== undefined && (!path || !Number.isInteger(hunkIndex) || hunkIndex < 0)) {
    return NextResponse.json(
      { error: "hunkIndex requires a path and a non-negative integer" },
      { status: 400 },
    );
  }

  let ok: boolean;
  let scope: string;
  if (path && hunkIndex !== undefined) {
    ok = action === "accept" ? acceptHunk(key, path, hunkIndex) : rejectHunk(key, path, hunkIndex);
    scope = `${path}#${hunkIndex}`;
  } else if (path) {
    ok = action === "accept" ? acceptFile(key, path) : rejectFile(key, path);
    scope = path;
  } else {
    const n = action === "accept" ? acceptAll(key) : rejectAll(key);
    ok = true;
    scope = `all (${n} files)`;
  }

  if (!ok) {
    // Stale hunk index or unknown path — the client refetches and retries.
    return NextResponse.json(
      { error: `nothing ${action}ed for ${scope} — refresh the change list` },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, action, scope });
}
