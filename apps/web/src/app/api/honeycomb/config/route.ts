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
  DEFAULT_HONEYCOMB_API_URL,
  deleteHoneycombConfig,
  honeycombConfigStatus,
  probeHoneycombKey,
  writeHoneycombConfig,
} from "@marvin/runtime/honeycomb-config";
import {
  applyHoneycombTelemetryEnv,
  honeycombTelemetryStatus,
} from "@marvin/runtime/honeycomb-telemetry";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    // Allow a cwd-less status so the UI can still render the env-var /
    // user-global path before the user picks a project.
    return NextResponse.json({
      ...honeycombConfigStatus(null),
      telemetry: honeycombTelemetryStatus(),
    });
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
  return NextResponse.json({
    ...honeycombConfigStatus(check.absolutePath),
    telemetry: honeycombTelemetryStatus(),
  });
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
  const rawApiUrl =
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

  // Region auto-detect: when the user didn't pick a URL (or left the
  // default US one) we probe US then EU with their key and persist
  // whichever cluster accepts it. Honeycomb doesn't tell you from the
  // key string alone which region it belongs to, so this removes the
  // "saved config works locally but Test fails 401" footgun that
  // bites every new EU user.
  //
  // If the user explicitly set a non-default apiUrl we trust them —
  // they may be pointing at a proxy, local mock, or a future region we
  // don't know about. We don't want to second-guess that.
  const userPickedCustomUrl =
    typeof rawApiUrl === "string" &&
    rawApiUrl.length > 0 &&
    rawApiUrl !== DEFAULT_HONEYCOMB_API_URL;
  let apiUrl = rawApiUrl;
  let regionAutoDetected = false;
  if (!userPickedCustomUrl) {
    const probe = await probeHoneycombKey(apiKey);
    if (probe.ok) {
      apiUrl = probe.apiUrl;
      regionAutoDetected = probe.apiUrl !== DEFAULT_HONEYCOMB_API_URL;
    }
    // If the probe failed we still save what the user asked for — the
    // key might be valid but Honeycomb was briefly unreachable, and
    // saving is the action the user explicitly requested. The failing
    // Test call they'll run next will tell them more.
  }

  const result = writeHoneycombConfig({
    workDir: check.absolutePath,
    apiKey,
    environment,
    ...(dataset ? { dataset } : {}),
    ...(apiUrl ? { apiUrl } : {}),
  });
  if (!result.ok) {
    // All validation errors are 400; only io-error falls through to 500.
    const status = result.error === "io-error" ? 500 : 400;
    return NextResponse.json(
      { error: result.error, detail: result.detail ?? null },
      { status },
    );
  }
  // Re-apply telemetry env vars immediately so the user sees "active"
  // in the UI and the next turn picks up the new config without
  // needing a server restart. applyHoneycombTelemetryEnv sweeps any
  // previously-exported MARVIN-managed vars before setting fresh
  // ones, so swapping API keys / datasets mid-session is clean.
  const telemetry = applyHoneycombTelemetryEnv(check.absolutePath);
  return NextResponse.json({
    ok: true,
    path: result.path,
    regionAutoDetected,
    // Surface the new status so the UI can render the freshly-saved
    // (masked) state without an extra GET round-trip. Same merged
    // shape as GET so the client only has to understand one response.
    status: {
      ...honeycombConfigStatus(check.absolutePath),
      telemetry,
    },
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
  // Re-apply immediately — with the per-project file gone,
  // applyHoneycombTelemetryEnv falls back to the global config
  // (or clears everything if there's none). The UI will show the
  // updated active/inactive state without waiting for the next turn.
  const telemetry = applyHoneycombTelemetryEnv(check.absolutePath);
  return NextResponse.json({
    ok: true,
    removed,
    status: {
      ...honeycombConfigStatus(check.absolutePath),
      telemetry,
    },
  });
}
