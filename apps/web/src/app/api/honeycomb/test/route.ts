/**
 * POST /api/honeycomb/test — verify the active Honeycomb config by
 * hitting Honeycomb's `/1/auth` endpoint. Returns the team slug and
 * environment name on success so the UI can confirm the user has
 * keyed in the right credentials without the user having to leave
 * MARVIN.
 *
 * Body: `{ cwd }` — resolves the config via the normal
 * env-var → workdir → global precedence. If the user hasn't saved
 * yet, there's nothing to test; 404.
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { readHoneycombConfig } from "@marvin/runtime/honeycomb-config";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AuthResponse {
  api_key_access?: Record<string, boolean>;
  environment?: { name?: string; slug?: string };
  team?: { name?: string; slug?: string };
}

export async function POST(req: NextRequest) {
  let body: { cwd?: unknown };
  try {
    body = (await req.json()) as { cwd?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
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

  const resolved = readHoneycombConfig(check.absolutePath);
  if (!resolved) {
    return NextResponse.json(
      { error: "not-configured", hint: "save a config first via POST /api/honeycomb/config" },
      { status: 404 },
    );
  }

  try {
    const base = (resolved.config.apiUrl ?? "https://api.honeycomb.io").replace(/\/$/, "");
    const res = await fetch(`${base}/1/auth`, {
      method: "GET",
      headers: {
        "X-Honeycomb-Team": resolved.config.apiKey,
        "User-Agent": "marvin/0.0.1",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (res.status === 401) {
      return NextResponse.json(
        {
          ok: false,
          error: "unauthorized",
          hint: "the API key was rejected by Honeycomb — rotate it and retry",
        },
        { status: 401 },
      );
    }
    if (!res.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "upstream-error",
          status: res.status,
          hint: "Honeycomb's /1/auth endpoint returned a non-2xx",
        },
        { status: 502 },
      );
    }
    const payload = (await res.json()) as AuthResponse;
    return NextResponse.json({
      ok: true,
      source: resolved.source,
      team: {
        name: payload.team?.name ?? null,
        slug: payload.team?.slug ?? null,
      },
      environment: {
        name: payload.environment?.name ?? null,
        slug: payload.environment?.slug ?? null,
        // Surface a warning if the configured environment name doesn't
        // match the one the API key actually belongs to — easy
        // misconfiguration to catch in the UI before a query fires.
        matchesConfigured:
          !!payload.environment?.name &&
          payload.environment.name.toLowerCase() ===
            resolved.config.environment.toLowerCase(),
      },
      apiKeyPermissions: payload.api_key_access ?? {},
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: "network-error", detail: message },
      { status: 502 },
    );
  }
}
