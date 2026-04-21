/**
 * POST /api/git/fetch — body `{ cwd, remote?: string }`
 *
 * `git fetch <remote>`. Auto-class (read-only on local refs). The
 * spawn inherits the user's env + credential helpers — MARVIN never
 * sees a password / token. `GIT_TERMINAL_PROMPT=0` (baked into
 * `runGit`) turns the "Username for …" interactive prompt into an
 * immediate failure with readable stderr.
 *
 * See [ADR-0013](../../../../../../../docs/decisions/0013-git-remote-ops-and-credentials.md).
 */

import { isSafeRemote, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

import { confirmGate } from "@/lib/git-confirm-gate";
import { remoteErrorResponse } from "@/lib/git-remote-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_REMOTE = "origin";
const FETCH_TIMEOUT_MS = 60_000;

export async function POST(req: NextRequest) {
  let body: { cwd?: unknown; remote?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const remote =
    typeof body.remote === "string" && body.remote.length > 0
      ? body.remote
      : DEFAULT_REMOTE;
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  if (!isSafeRemote(remote)) {
    return NextResponse.json(
      { error: "invalid-remote", value: remote },
      { status: 400 },
    );
  }

  const sandbox = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!sandbox.ok || !sandbox.isDirectory) {
    return NextResponse.json(
      { error: sandbox.ok ? "cwd is not a directory" : sandbox.error },
      { status: 400 },
    );
  }
  const root = sandbox.absolutePath;

  const gate = confirmGate(req, { kind: "fetch", remote }, root);
  if (!gate.allow) return gate.response;

  const res = await runGit(root, ["fetch", remote], {
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!res.ok) {
    return remoteErrorResponse("stderr" in res ? (res.stderr ?? res.detail ?? "") : res.detail ?? "");
  }
  return NextResponse.json({
    ok: true,
    remote,
    // `git fetch` emits progress on stderr; pass it through so the
    // UI can show "fetching origin/main… done" style output.
    note: res.stderr.trim() || null,
  });
}
