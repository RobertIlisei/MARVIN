/**
 * GET    /api/auth/config              → masked status for the UI
 * POST   /api/auth/config              → write ~/.marvin/auth-config.json
 * DELETE /api/auth/config              → remove the file
 *
 * The raw apiKey only travels in a POST body; every GET response
 * returns a redacted form (last-4 only). File permissions are set
 * to 0600 on write. See `packages/runtime/src/auth-config.ts` for
 * the storage layout + resolution precedence.
 */

import {
  authConfigFileMode,
  authConfigStatus,
  deleteAuthConfig,
  writeAuthConfig,
} from "@marvin/runtime/auth-config";
import { getAnthropicAuth } from "@marvin/runtime/auth";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

interface PostBody {
  mode?: string;
  apiKey?: string;
}

function payload() {
  return {
    config: authConfigStatus(),
    file: authConfigFileMode(),
    // The mode the resolver actually picks right now — could differ from
    // the config's chosen mode when the user picked "cli" but no host
    // credentials are on disk, in which case effective.mode === "none".
    effective: getAnthropicAuth(),
  };
}

export async function GET() {
  return NextResponse.json(payload());
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const lengthHeader = Number(req.headers.get("content-length") || 0);
  if (lengthHeader > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body too large" }, { status: 413 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const mode = body.mode;
  if (mode !== "cli" && mode !== "api-key") {
    return NextResponse.json(
      { error: "mode must be 'cli' or 'api-key'" },
      { status: 400 },
    );
  }

  const result = writeAuthConfig({
    mode,
    apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(payload());
}

export async function DELETE(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  const out = deleteAuthConfig();
  return NextResponse.json({ ...payload(), removed: out.removed });
}
