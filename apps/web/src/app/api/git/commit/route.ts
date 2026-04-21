/**
 * POST /api/git/commit — body `{ cwd, message, amend?: boolean }`
 *
 * Commits the index. Message travels via stdin (`-F -`) so user text
 * never touches argv. `amend` rewrites HEAD; if HEAD has already been
 * pushed (detected via `git merge-base --is-ancestor HEAD @{u}`),
 * the op is classified confirm-danger because it rewrites shared
 * history.
 *
 * Requires something to commit (staged changes for non-amend; any
 * valid HEAD for amend) — otherwise `git commit` exits non-zero and
 * we surface the stderr.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafeCommitMessage, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

import { confirmGate } from "@/lib/git-confirm-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { cwd?: unknown; message?: unknown; amend?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const message = typeof body.message === "string" ? body.message : "";
  const amend = body.amend === true;
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  // Non-amend commits require a valid message; amend-without-message
  // keeps the existing one (git's `--amend` default). Policy has the
  // same rule; we repeat here for an early 400 instead of wasting a
  // policy call.
  if (!amend && !isSafeCommitMessage(message)) {
    return NextResponse.json(
      { error: "invalid-message", reason: "empty, NUL, or > 16 KB" },
      { status: 400 },
    );
  }
  if (amend && message && !isSafeCommitMessage(message)) {
    return NextResponse.json(
      { error: "invalid-message", reason: "NUL or > 16 KB" },
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

  const hasPushedHead = await detectPushedHead(root);

  const gate = confirmGate(
    req,
    { kind: "commit", message, amend, hasPushedHead },
    root,
  );
  if (!gate.allow) return gate.response;

  // Argv construction — never interpolate the message. `-F -` reads
  // it from stdin. When amending without a new message, fall through
  // to `--no-edit` so git keeps the existing one.
  const argv = ["commit"];
  if (amend) argv.push("--amend");
  if (amend && !message) {
    argv.push("--no-edit");
  } else {
    argv.push("-F", "-");
  }

  const res = await runGit(root, argv, {
    timeoutMs: 15_000,
    ...(message ? { stdin: message } : {}),
  });
  if (!res.ok) {
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    // `nothing to commit` → 409 so the UI can render a friendly
    // "nothing staged" message instead of a generic 502.
    if (stderr.includes("nothing to commit")) {
      return NextResponse.json(
        { error: "nothing-to-commit" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: res.error, detail: stderr || res.detail },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, amend, hasPushedHead });
}

/**
 * Returns `true` when the current HEAD is reachable from the configured
 * upstream — i.e., amending HEAD rewrites history that has been
 * published. `false` when there's no upstream or HEAD is ahead of it.
 *
 * Implementation: `git rev-parse @{u}` to confirm an upstream, then
 * `git merge-base --is-ancestor HEAD @{u}` — exits 0 if HEAD is an
 * ancestor of upstream (i.e., upstream has HEAD).
 */
async function detectPushedHead(root: string): Promise<boolean> {
  const upstream = await runGit(
    root,
    ["rev-parse", "--abbrev-ref", "@{u}"],
    { timeoutMs: 2000 },
  );
  if (!upstream.ok) return false;

  const ancestor = await runGit(
    root,
    ["merge-base", "--is-ancestor", "HEAD", "@{u}"],
    { timeoutMs: 2000 },
  );
  // `--is-ancestor` uses exit code 0 for yes, 1 for no. `runGit`
  // returns `non-zero-exit` on 1; we distinguish via exitCode.
  return ancestor.ok;
}
