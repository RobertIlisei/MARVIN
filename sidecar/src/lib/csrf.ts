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
 * Server-side guard. Call at the top of every mutating route handler.
 * Returns a 403 NextResponse when the header is missing; returns null
 * when the request is safe to continue.
 *
 * 403 rather than 401 because the user's session isn't the issue —
 * the REQUEST SHAPE is. A client that can't add a custom header is
 * one we don't accept mutations from, period.
 *
 * The error body intentionally carries the required header name and
 * value so a legitimate developer hitting this endpoint via curl gets
 * a useful message instead of a blank wall. Attackers can't use it to
 * bypass anything — they can't add the header from a drive-by tab by
 * design; the error is just diagnostic text.
 */
export function requireMarvinClient(req: NextRequest): NextResponse | null {
  const header = req.headers.get(MARVIN_CLIENT_HEADER);
  if (header === MARVIN_CLIENT_VALUE) return null;
  return NextResponse.json(
    {
      error: "csrf-guard",
      detail: `mutating routes require "${MARVIN_CLIENT_HEADER}: ${MARVIN_CLIENT_VALUE}" — this forces a CORS preflight so a drive-by tab at another origin cannot trigger the request`,
    },
    { status: 403 },
  );
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
