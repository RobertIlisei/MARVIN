import { listModels } from "@marvin/runtime/models";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/models
 *
 * Returns Anthropic's live model list when credentials are available;
 * otherwise a small fallback list, flagged with `source: "fallback"`
 * so the UI can warn the user the list may be stale.
 *
 * Response:
 *   {
 *     models: ModelInfo[],     // sorted opus → sonnet → haiku → other
 *     source: "anthropic-api" | "fallback",
 *     error: string | null,
 *     fetchedAt: string        // ISO timestamp
 *   }
 *
 * The endpoint is cheap (one-time request, no streaming) so the client
 * can call it whenever the model picker opens.
 */
export async function GET() {
  const result = await listModels();
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
}
