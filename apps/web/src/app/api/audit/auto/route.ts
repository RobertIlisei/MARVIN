/**
 * GET /api/audit/auto?cwd=...&limit=50
 *
 * Returns the tail of `<cwd>/.marvin/auto-audit.jsonl` so the
 * Settings panel can show recent auto-allowed mutations under the
 * `auto` permission strategy.
 *
 * See [docs/reviews/2026-04-26-full-audit.md, finding #2].
 */

import { readAutoAuditTail } from "@marvin/runtime/auto-audit";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd")?.trim();
  const limitRaw = url.searchParams.get("limit");
  const limit = (() => {
    if (!limitRaw) return 50;
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return 50;
    return Math.min(n, 500); // hard cap so a malicious caller can't slurp the whole file
  })();

  if (!cwd) {
    return new Response(
      JSON.stringify({ error: "cwd is required", code: "missing-cwd" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Sandbox cwd through the same checker every other route uses. Stops
  // a request from probing arbitrary disk paths via `?cwd=/etc`.
  const check = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!check.ok) {
    return new Response(
      JSON.stringify({
        error: `cwd is not a usable project root: ${check.detail}`,
        code: check.error,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const entries = readAutoAuditTail(check.absolutePath, limit);
  // File order is chronological; reverse so the UI sees newest first.
  const newestFirst = [...entries].reverse();

  return new Response(JSON.stringify({ entries: newestFirst }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
