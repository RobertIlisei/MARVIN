/**
 * GET  /api/honeycomb/config?cwd=…   → masked status for the UI
 * POST /api/honeycomb/config         → write <cwd>/.marvin/honeycomb.json
 * DELETE /api/honeycomb/config?cwd=… → remove the per-project file
 *
 * The raw apiKey only travels in a POST body; every GET response
 * returns a redacted form. File permissions are set to 600 on write.
 * See `packages/runtime/src/honeycomb-config.ts` for the storage
 * layout + resolution precedence.
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import {
  deleteHoneycombConfig,
  honeycombConfigStatus,
  writeHoneycombConfig,
} from "@marvin/runtime/honeycomb-config";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    // Allow a cwd-less status so the UI can still render the env-var /
    // user-global path before the user picks a project.
    return NextResponse.json(honeycombConfigStatus(null));
  }
  const check = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }
  return NextResponse.json(honeycombConfigStatus(check.absolutePath));
}

export async function POST(req: NextRequest) {
  // Guard against oversized payloads (the real body fits in ~400 bytes).
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "body-too-large" }, { status: 413 });
  }
  let body: {
    cwd?: unknown;
    apiKey?: unknown;
    environment?: unknown;
    dataset?: unknown;
    apiUrl?: unknown;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
  const environment =
    typeof body.environment === "string" ? body.environment : null;
  if (!cwd || !apiKey || !environment) {
    return NextResponse.json(
      { error: "cwd, apiKey, environment required" },
      { status: 400 },
    );
  }
  const dataset =
    typeof body.dataset === "string" ? body.dataset.trim() : undefined;
  const apiUrl =
    typeof body.apiUrl === "string" ? body.apiUrl.trim() : undefined;

  const check = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const result = writeHoneycombConfig({
    workDir: check.absolutePath,
    apiKey,
    environment,
    ...(dataset ? { dataset } : {}),
    ...(apiUrl ? { apiUrl } : {}),
  });
  if (!result.ok) {
    const status =
      result.error === "empty-api-key" ||
      result.error === "empty-environment" ||
      result.error === "invalid-api-url"
        ? 400
        : 500;
    return NextResponse.json(
      { error: result.error, detail: result.detail ?? null },
      { status },
    );
  }
  return NextResponse.json({
    ok: true,
    path: result.path,
    // Surface the new status so the UI can render the freshly-saved
    // (masked) state without an extra GET round-trip.
    status: honeycombConfigStatus(check.absolutePath),
  });
}

export async function DELETE(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const check = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 });
  }
  const { removed } = deleteHoneycombConfig(check.absolutePath);
  return NextResponse.json({
    ok: true,
    removed,
    status: honeycombConfigStatus(check.absolutePath),
  });
}
