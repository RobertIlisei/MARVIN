/**
 * CSRF hardening for mutating API routes.
 *
 * Every mutating route (POST / DELETE / PUT / PATCH under /api/*) must
 * require a custom request header that the browser refuses to add on
 * a simple cross-origin request. That forces a preflight, which
 * browsers gate on a `Access-Control-Allow-Origin` response that
 * MARVIN never emits — so a drive-by tab at `evil.com` can't POST to
 * `localhost:3030` and get the server to act on the user's behalf.
 *
 * The mechanism predates this file: ADR-0009 established the same
 * pattern for the multipart-upload route. This module generalises it
 * so every mutating route gets the same guarantee, and so client code
 * can attach the header once via the `marvinFetch` wrapper instead of
 * remembering it per call site.
 *
 * Scope:
 * - Applied to POST / DELETE / PUT / PATCH. NOT applied to GET (read-
 *   only; cross-origin reads are blocked by SOP already, and adding a
 *   header requirement would break simple curl usage like
 *   `curl /api/health`).
 * - SSE + streaming routes don't need it on the streaming side (they're
 *   GETs), but the POST that initiates a stream does.
 *
 * Threat model:
 * MARVIN runs on `localhost:3030` in the user's browser. A malicious
 * tab in the same browser can hit the server directly. The CSRF
 * vector is "simple request" CORS: any `Content-Type: application/json`
 * POST from another origin gets through the preflight because
 * `application/json` is not on the browser's allowlist — wait, it IS
 * preflight-required since CORS 2024 clarification, but not every
 * browser / userscript respects that consistently, and belt-and-braces
 * is the right default. The custom header is what actually forces the
 * preflight reliably.
 */

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const MARVIN_CLIENT_HEADER = "x-marvin-client";
export const MARVIN_CLIENT_VALUE = "1";

/**
 * Allowed origins for mutating requests. The sidecar only ever serves
 * UI on loopback (`localhost` / `127.0.0.1`) — any other Origin is
 * either a misconfiguration or a hostile cross-origin attempt.
 *
 * Audit 🟠 #5: the prior `requireMarvinClient` relied solely on the
 * `X-Marvin-Client` custom header forcing a CORS preflight. That's
 * load-bearing against drive-by browser tabs, but breaks down in
 * three scenarios:
 *   • a same-origin XSS on any localhost-bound dev server (it can
 *     add the custom header trivially);
 *   • a userscript or non-browser client (curl, electron) that adds
 *     the header by hand;
 *   • a future browser bug that relaxes the preflight.
 *
 * Adding an Origin / Sec-Fetch-Site allowlist closes those gaps:
 * even a same-origin XSS at `attacker.localhost:8080` now fails the
 * Origin check, and a hostile curl call has to spoof both signals.
 */
const ALLOWED_ORIGIN_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",  // IPv6 loopback
]);

function isAllowedOrigin(originValue: string | null): boolean {
  if (!originValue) return false;
  try {
    const url = new URL(originValue);
    // `URL.hostname` strips brackets from IPv6 literals; restore them
    // so we can compare uniformly with the `[::1]` entry.
    const host = originValue.startsWith("http://[::") || originValue.startsWith("https://[::")
      ? `[${url.hostname}]`
      : url.hostname;
    return ALLOWED_ORIGIN_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Server-side guard. Call at the top of every mutating route handler.
 * Returns a 403 NextResponse when the request fails any of:
 *   1. `X-Marvin-Client: 1` custom header is present
 *   2. `Origin` (or `Referer` as fallback) resolves to localhost
 *   3. `Sec-Fetch-Site` is absent or one of `same-origin` / `none`
 *      (the values browsers set for first-party fetches)
 *
 * Returns null when the request is safe to continue.
 *
 * 403 rather than 401 because the user's session isn't the issue —
 * the REQUEST SHAPE is. A client that can't satisfy all three checks
 * is one we don't accept mutations from, period.
 */
export function requireMarvinClient(req: NextRequest): NextResponse | null {
  // 1. Custom-header check — the original CSRF defence. A drive-by
  //    tab can't add this header without first satisfying the
  //    preflight, which we never accept.
  const header = req.headers.get(MARVIN_CLIENT_HEADER);
  if (header !== MARVIN_CLIENT_VALUE) {
    return NextResponse.json(
      {
        error: "csrf-guard",
        detail: `mutating routes require "${MARVIN_CLIENT_HEADER}: ${MARVIN_CLIENT_VALUE}" — this forces a CORS preflight so a drive-by tab at another origin cannot trigger the request`,
      },
      { status: 403 },
    );
  }

  // 2. Origin allowlist. Browsers send Origin on all cross-origin
  //    requests AND on same-origin POSTs. Curl + Electron + scripts
  //    can spoof it but must do so explicitly — combined with #1
  //    the bar is meaningfully higher than header-only.
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  // Most browser requests carry Origin. CLI clients sometimes only
  // carry Referer (rare for POSTs but possible). Accept either.
  const candidate = origin ?? referer;
  if (candidate !== null && !isAllowedOrigin(candidate)) {
    return NextResponse.json(
      {
        error: "csrf-guard-origin",
        detail: `Origin "${candidate}" not in the allowlist (localhost / 127.0.0.1 / [::1])`,
      },
      { status: 403 },
    );
  }

  // 3. Sec-Fetch-Site — set by every modern browser. Acceptable
  //    values for our case: `same-origin` (UI calling its own
  //    sidecar) and `none` (user-typed URL, browser extension, or
  //    server-initiated request that has no referrer). Cross-origin
  //    fetches set `cross-site` or `same-site` — both rejected.
  const sfs = req.headers.get("sec-fetch-site");
  if (sfs !== null && sfs !== "same-origin" && sfs !== "none") {
    return NextResponse.json(
      {
        error: "csrf-guard-fetch-site",
        detail: `Sec-Fetch-Site "${sfs}" indicates a cross-origin request`,
      },
      { status: 403 },
    );
  }

  return null;
}

/**
 * Client-side fetch wrapper that always adds the CSRF header and a
 * `Content-Type: application/json` when a JSON body is supplied.
 *
 * Drop-in for `fetch()` on mutating calls. Existing code using raw
 * `fetch` continues to work but gets blocked by the server guard
 * above; migrating to `marvinFetch` is the intended fix.
 *
 * Does NOT set the header on GET requests — the guard doesn't check
 * GETs, and leaving the header off keeps preflight off for cheap
 * reads.
 */
export async function marvinFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers ?? {});
  if (method !== "GET" && method !== "HEAD") {
    headers.set(MARVIN_CLIENT_HEADER, MARVIN_CLIENT_VALUE);
    // Auto-default JSON content-type for string / object bodies when
    // the caller hasn't set one. Skipped for FormData / Blob / ArrayBuffer
    // (multipart + raw blobs need their own type).
    if (
      !headers.has("Content-Type") &&
      init.body !== undefined &&
      init.body !== null &&
      typeof init.body === "string"
    ) {
      headers.set("Content-Type", "application/json");
    }
  }
  return fetch(input, { ...init, headers });
}
