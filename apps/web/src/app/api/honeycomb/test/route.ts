/**
 * POST /api/honeycomb/test — verify a Honeycomb config by hitting
 * Honeycomb's `/1/auth` endpoint. Returns the team slug and environment
 * name on success so the UI can confirm the user has keyed in the right
 * credentials without leaving MARVIN.
 *
 * Two test modes:
 *   1. **Saved** — body `{ cwd }`. Resolves config via env-var →
 *      workdir → global precedence. 404 if nothing is configured.
 *   2. **Ad-hoc** — body `{ cwd, apiKey, apiUrl?, environment? }`.
 *      Tests the provided credentials without writing anything to
 *      disk. Lets the UI validate before Save.
 *
 * Region fallback: if the first attempt 401s on the default (US)
 * cluster, we retry the EU cluster (`api.eu1.honeycomb.io`). If EU
 * accepts the key, the response includes `regionFallback: true` and
 * `suggestedApiUrl` so the UI can offer a one-click fix. Most Honeycomb
 * 401s in the wild are actually region mismatches, not bad keys.
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import {
  DEFAULT_HONEYCOMB_API_URL,
  HONEYCOMB_CANDIDATE_URLS,
  probeHoneycombKey,
  probeHoneycombKeyAt,
  readHoneycombConfig,
} from "@marvin/runtime/honeycomb-config";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TestBody {
  cwd?: unknown;
  // Optional — when present, test these values instead of the saved
  // config. Lets the UI validate before Save.
  apiKey?: unknown;
  apiUrl?: unknown;
  environment?: unknown;
}

export async function POST(req: NextRequest) {
  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
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

  // Resolve which credentials to test: inline (dirty form) overrides
  // the saved config. `environment` is optional in inline mode — only
  // used for the matchesConfigured hint.
  const inlineKey =
    typeof body.apiKey === "string" && body.apiKey.trim().length > 0
      ? body.apiKey.trim()
      : null;
  const inlineApiUrl =
    typeof body.apiUrl === "string" && body.apiUrl.trim().length > 0
      ? body.apiUrl.trim()
      : null;
  const inlineEnv =
    typeof body.environment === "string" ? body.environment.trim() : "";

  let apiKey: string;
  let configuredApiUrl: string;
  let configuredEnvironment: string;
  let source: "env" | "workdir" | "global" | "inline";

  if (inlineKey) {
    apiKey = inlineKey;
    configuredApiUrl = inlineApiUrl ?? DEFAULT_HONEYCOMB_API_URL;
    configuredEnvironment = inlineEnv;
    source = "inline";
  } else {
    const resolved = readHoneycombConfig(check.absolutePath);
    if (!resolved) {
      return NextResponse.json(
        {
          error: "not-configured",
          hint: "save a config first, or pass apiKey in the request body",
        },
        { status: 404 },
      );
    }
    apiKey = resolved.config.apiKey;
    configuredApiUrl = resolved.config.apiUrl ?? DEFAULT_HONEYCOMB_API_URL;
    configuredEnvironment = resolved.config.environment;
    // readHoneycombConfig's return type widens `source` to include
    // "none", but "none" is only produced when the function returns
    // null — and we've already null-checked above. Narrow explicitly
    // so the union stays tight through authSuccessResponse.
    source = resolved.source === "none" ? "global" : resolved.source;
  }

  // Probe strategy:
  //   1. Try the configured cluster first.
  //   2. On 401, fall back to the *other* known cluster so EU users
  //      who saved with the US default still get a useful answer.
  //   3. On any non-2xx/non-401 we surface it verbatim — those are
  //      usually transport problems worth seeing.
  const first = await probeHoneycombKeyAt(apiKey, configuredApiUrl);
  if (first.ok) {
    return NextResponse.json(
      authSuccessResponse({
        apiUrl: configuredApiUrl,
        payload: first.payload,
        configuredEnvironment,
        source,
        regionFallback: false,
      }),
    );
  }

  // Only retry other regions for an actual 401. Network / 5xx are not
  // region-specific; retrying would just muddle the diagnostic.
  if (first.status === 401) {
    const others = HONEYCOMB_CANDIDATE_URLS.filter(
      (u) => u !== configuredApiUrl,
    );
    const fallback = await probeHoneycombKey(apiKey, others);
    if (fallback.ok) {
      return NextResponse.json(
        authSuccessResponse({
          apiUrl: fallback.apiUrl,
          payload: {
            team: fallback.team,
            environment: fallback.environment,
            api_key_access: fallback.apiKeyAccess,
          },
          configuredEnvironment,
          source,
          regionFallback: true,
          configuredApiUrl,
        }),
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: "unauthorized",
        hint: "the API key was rejected by every Honeycomb cluster we tried — rotate it, or check you copied the whole key",
        attempts: [
          { apiUrl: configuredApiUrl, status: 401 },
          ...fallback.attempts,
        ],
      },
      { status: 401 },
    );
  }

  if (first.status === "network-error") {
    return NextResponse.json(
      {
        ok: false,
        error: "network-error",
        hint: "couldn't reach Honeycomb — check connectivity",
        detail: first.detail ?? null,
      },
      { status: 502 },
    );
  }

  return NextResponse.json(
    {
      ok: false,
      error: "upstream-error",
      status: first.status,
      hint: "Honeycomb's /1/auth endpoint returned a non-2xx",
      detail: first.detail ?? null,
    },
    { status: 502 },
  );
}

interface AuthPayloadShape {
  api_key_access?: Record<string, boolean>;
  environment?: { name?: string | null; slug?: string | null };
  team?: { name?: string | null; slug?: string | null };
}

function authSuccessResponse(args: {
  apiUrl: string;
  payload: AuthPayloadShape;
  configuredEnvironment: string;
  source: "env" | "workdir" | "global" | "inline";
  regionFallback: boolean;
  configuredApiUrl?: string;
}) {
  const { apiUrl, payload, configuredEnvironment, source, regionFallback } =
    args;
  const envName = payload.environment?.name ?? null;
  return {
    ok: true,
    source,
    apiUrl,
    regionFallback,
    // When we've fallen back, hand the UI the right URL to persist.
    ...(regionFallback ? { suggestedApiUrl: apiUrl } : {}),
    ...(regionFallback && args.configuredApiUrl
      ? { configuredApiUrl: args.configuredApiUrl }
      : {}),
    team: {
      name: payload.team?.name ?? null,
      slug: payload.team?.slug ?? null,
    },
    environment: {
      name: envName,
      slug: payload.environment?.slug ?? null,
      // Warn if the configured env doesn't match the one the key
      // belongs to — an easy misconfig to catch in the UI.
      matchesConfigured:
        !!envName &&
        !!configuredEnvironment &&
        envName.toLowerCase() === configuredEnvironment.toLowerCase(),
    },
    apiKeyPermissions: payload.api_key_access ?? {},
  };
}
