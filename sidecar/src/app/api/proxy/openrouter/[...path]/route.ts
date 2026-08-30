import { NextRequest } from "next/server";

import { requireLoopbackClient } from "@/lib/csrf";
import { PROXY_TOKEN_HEADER, proxyToken } from "@marvin/runtime/auth";

// Node runtime, not edge. The branch shipped this as `edge` ("ideal for
// streaming proxies"), but MARVIN's sidecar IS a standalone Node server —
// every other route here is `nodejs`, and an edge route cannot import the
// runtime package, which is where the proxy token lives (`node:crypto`
// is unavailable on edge, and the build fails collecting page data).
// Streaming is unaffected: the response body is piped through untouched,
// exactly as /api/chat streams SSE on this same runtime.
export const runtime = "nodejs";

/**
 * Local proxy to bridge the Claude Code SDK to OpenRouter.
 * 
 * The Claude SDK enforces that `ANTHROPIC_API_KEY` starts with `sk-ant-`, and it 
 * exclusively sends the key via the `x-api-key` header.
 * 
 * OpenRouter, however, requires the actual key (sk-or-v1-...) in the 
 * `Authorization: Bearer <key>` header.
 * 
 * This route intercepts requests sent to the local sidecar, strips the fake `sk-ant-api03-` 
 * prefix from the `x-api-key` header, and proxies the request to OpenRouter with 
 * the correct `Authorization` header.
 */
/**
 * Constant-time string compare. `node:crypto.timingSafeEqual` is unavailable
 * on the edge runtime this route uses, and `===` on a secret leaks its prefix
 * through timing.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(
  req: NextRequest
) {
  // CSRF half-guard (ADR-0009 lineage): the client here is the Claude CLI
  // subprocess, which can't send X-Marvin-Client — but a browser always
  // attaches Origin / Sec-Fetch-Site to a cross-origin POST, so the
  // loopback checks still stop a drive-by tab from spending the user's
  // OpenRouter credit through this proxy.
  const guard = requireLoopbackClient(req);
  if (guard) return guard;

  // Second gate: a shared secret minted per sidecar process and handed to the
  // CLI via ANTHROPIC_CUSTOM_HEADERS (see buildSubprocessEnv). The loopback
  // checks above stop a browser tab; this stops any OTHER local process from
  // spending the user's OpenRouter credit through a route that, by necessity,
  // cannot demand `X-Marvin-Client`.
  const presented = req.headers.get(PROXY_TOKEN_HEADER.toLowerCase());
  const expected = proxyToken();
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    return new Response(
      JSON.stringify({ error: "proxy-token", detail: "missing or invalid proxy token" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // Extract the path after /api/proxy/openrouter
  // e.g. /api/proxy/openrouter/v1/messages -> /v1/messages
  let pathString = req.nextUrl.pathname.replace(/^\/api\/proxy\/openrouter\/?/, "");
  
  // Depending on how the Anthropic SDK is initialized in the CLI, it might or 
  // might not include "v1/" in the path. Ensure it's present for OpenRouter.
  if (!pathString.startsWith("v1/") && !pathString.startsWith("v1")) {
    // e.g. pathString is "messages", make it "v1/messages"
    // or pathString is empty, make it "v1/"
    pathString = pathString ? `v1/${pathString}` : "v1/messages";
  }

  // OpenRouter has no Anthropic-format count_tokens endpoint — it 404s
  // (verified 2026-08-30, alongside `POST /v1/messages` which is real). The
  // Claude CLI calls it to verify the model and to size the prompt, and on a
  // 404 aborts with "There's an issue with the selected model", which is what
  // made skills unusable on OpenRouter. So the proxy has to answer it.
  //
  // It answers with an ESTIMATE, not a zero. The first version returned
  // `{input_tokens: 0}`, which unblocks the CLI and then lies to it for the
  // rest of the session: this endpoint feeds context accounting, so a constant
  // zero tells the CLI every prompt is empty — context-pressure tracking and
  // the auto-compaction trigger would both read as "no pressure" right up to
  // a hard overflow. A rough number degrades gracefully; zero fails silently
  // and in the dangerous direction.
  //
  // ~4 chars per token is the standard rough ratio and is what MARVIN's own
  // context estimator already uses for its category rows. It will be off by
  // some percent; it will not be off by everything.
  if (pathString === "v1/messages/count_tokens") {
    let estimated = 0;
    try {
      const raw = await req.clone().text();
      estimated = Math.max(1, Math.ceil(raw.length / 4));
    } catch {
      // Body unreadable — fall back to a non-zero floor rather than 0, for
      // the same reason: a wrong-but-plausible number beats a confident lie.
      estimated = 1;
    }
    return new Response(JSON.stringify({ input_tokens: estimated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  
  const targetUrl = `https://openrouter.ai/api/${pathString}`;

  // Read the spoofed key from the Anthropic SDK header
  const fakeKey = req.headers.get("x-api-key");
  
  // Extract the real OpenRouter key by removing our fake prefix
  let realKey = fakeKey || "";
  if (realKey.startsWith("sk-ant-api03-")) {
    realKey = realKey.substring("sk-ant-api03-".length);
  }

  // Construct new headers for OpenRouter
  const headers = new Headers();
  
  // Forward all original headers (except host and x-api-key)
  req.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey !== "host" &&
      lowerKey !== "x-api-key" &&
      lowerKey !== PROXY_TOKEN_HEADER.toLowerCase()
    ) {
      headers.set(key, value);
    }
  });

  // Inject the real OpenRouter API key
  headers.set("Authorization", `Bearer ${realKey}`);
  
  // OpenRouter specific headers for app identification
  headers.set("HTTP-Referer", "https://github.com/RobertIlisei/MARVIN");
  headers.set("X-Title", "MARVIN");

  try {
    const body = await req.text();
    console.log(`[PROXY] Sending request to ${targetUrl} with method POST and body length ${body.length}`);
    
    // Proxy the request to OpenRouter
    const response = await fetch(targetUrl, {
      method: "POST",
      headers,
      body,
    });
    
    console.log(`[PROXY] OpenRouter returned status: ${response.status}`);

    // Create a new response passing through OpenRouter's stream and status
    const proxyHeaders = new Headers(response.headers);
    // Remove headers that might cause issues when proxying
    proxyHeaders.delete("content-encoding");
    proxyHeaders.delete("transfer-encoding");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyHeaders,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Proxy request failed" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
