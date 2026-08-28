import { NextRequest } from "next/server";

import { requireLoopbackClient } from "@/lib/csrf";

export const runtime = "edge"; // Edge runtime is ideal for streaming proxies

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
    if (lowerKey !== "host" && lowerKey !== "x-api-key") {
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
