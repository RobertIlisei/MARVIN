/**
 * GET /api/commands?projectId=…&q=…  → { commands, capturedAt }
 *
 * Serves the slash-command catalog (skills, built-ins, plugin commands) with
 * descriptions + argument hints, for the composer's `/` autocomplete. The
 * catalog is captured from `query().supportedCommands()` during turns and
 * cached per project (`slash-commands.ts`), so it survives sidecar restarts
 * and is available before the first turn of a fresh chat.
 *
 * Read-only and cheap — no CSRF guard needed (matches the other GET reads).
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  buildFilesystemCatalog,
  filterCommands,
  mergeCatalogs,
  readSlashCommands,
} from "@marvin/runtime/slash-commands";
import { validateProjectCwd } from "@marvin/runtime/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const projectId = params.get("projectId")?.trim();
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }
  // Skills are readable from disk with no turn required, so the composer has
  // autocomplete the moment a project opens. The SDK-captured catalog (which
  // also knows built-ins and plugin commands) merges in on top once available.
  const workDir = params.get("workDir")?.trim();
  let filesystem: ReturnType<typeof buildFilesystemCatalog> = [];
  if (workDir) {
    const v = validateProjectCwd(workDir);
    if (v.ok) filesystem = buildFilesystemCatalog(v.workDir);
  }
  const captured = readSlashCommands(projectId);
  const commands = mergeCatalogs(captured?.commands ?? [], filesystem);
  // NOTE: no query → return the FULL catalog, untruncated. The client fetches
  // once and filters locally as you type, so applying the display limit here
  // silently dropped every command past the 40th alphabetically — they became
  // unfindable no matter what you typed. A display cap is not a transport cap.
  const q = params.get("q") ?? "";
  const result = q ? filterCommands(commands, q) : commands;
  // Observability: proves whether the composer is actually querying, and with
  // what. Without it, "client shows wrong results" is indistinguishable from
  // "client never called".
  try {
    console.info(
      "[marvin.telemetry] " +
        JSON.stringify({
          kind: "commands.query",
          q,
          returned: result.length,
          top: result.slice(0, 3).map((c) => c.name),
          at: new Date().toISOString(),
        }),
    );
  } catch {
    /* never break the response on a log */
  }
  return NextResponse.json({
    commands: result,
    capturedAt: captured?.capturedAt ?? null,
    sources: { captured: captured?.commands.length ?? 0, filesystem: filesystem.length },
  });
}
