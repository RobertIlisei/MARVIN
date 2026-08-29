import { getAnthropicAuth } from "@marvin/runtime/auth";
import { discoverClaudeBinary } from "@marvin/runtime/claude-cli";
import { defaultModelIsLive, resolveDefaultModel } from "@marvin/runtime/models";
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
      // The model a turn would use if the user picked nothing. Resolved
      // LIVE (cached discovery, falling back to the static list only when
      // the API is unreachable) — it used to be the sync `defaultModel()`,
      // whose answer is the newest entry of a hardcoded list. That list had
      // gone stale, so the About panel reported `claude-opus-4-8` while
      // turns actually ran on Sonnet 5 (user, 2026-08-30).
      model: await resolveDefaultModel(),
      /** True when `model` came from the live catalogue rather than the
       *  hardcoded fallback, so the UI can say which it is. */
      modelIsLive: await defaultModelIsLive(),
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
