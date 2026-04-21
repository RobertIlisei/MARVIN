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
      model: defaultModel(),
      dataDir: getMarvinDataDir(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
