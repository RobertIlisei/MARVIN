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
      // ADR-0035 — the app version this sidecar was spawned by.
      // SidecarManager injects MARVIN_APP_VERSION at spawn; null means a
      // dev sidecar (pnpm dev) or a pre-0.1.19 bundle. Lets any observer
      // (About panel, release verification, debugging) confirm the
      // SERVING process matches the bundle on disk — the stale-sidecar-
      // adoption failure was invisible without it.
      version: process.env.MARVIN_APP_VERSION ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
