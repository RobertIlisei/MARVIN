import { getAnthropicAuth } from "@marvin/runtime/auth";
import { defaultModel, discoverClaudeBinary } from "@marvin/runtime/claude-cli";
import { getMarvinDataDir } from "@marvin/runtime/paths";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const auth = getAnthropicAuth();
  let binaryPath: string | null = null;
  let binaryError: string | null = null;
  try {
    binaryPath = discoverClaudeBinary();
  } catch (err) {
    binaryError = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json(
    {
      ok: auth.mode !== "none" && !binaryError,
      auth,
      claudeBinary: binaryPath,
      binaryError,
      // Named `defaultModel` (not `model`) because this is the fallback
      // the chat route drops to when a turn doesn't get an explicit
      // model — NOT what any active turn is using.
      // See docs/operations/health.md + docs/concepts/advisor-strategy.md.
      defaultModel: defaultModel(),
      dataDir: getMarvinDataDir(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
