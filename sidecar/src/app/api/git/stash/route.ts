/**
 * GET  /api/git/stash?cwd=…            — list stash entries
 * POST /api/git/stash                  — body `{ cwd, action, message?, index? }`
 *
 * Actions: `push` (auto), `pop` / `apply` (auto), `drop` (confirm
 * danger). The stash is the remedy the branch-switch policy points at
 * when it refuses a dirty tree, so the panel needs it to close that
 * loop rather than sending the user to a terminal.
 *
 * `index` addresses an entry positionally (`stash@{N}`). We build that
 * ref ourselves from a validated integer rather than accepting a ref
 * string — `stash@{…}` contains `@{`, which `isSafeRef` rejects on
 * purpose (it is reflog syntax), so there is no way to pass one in.
 *
 * See [ADR-0012](../../../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import { isSafeCommitMessage, runGit } from "@marvin/git";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";
import { confirmGate } from "@/lib/git-confirm-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `%x00`, NOT `%00`. Git's format placeholders are per-command
// dialects: `for-each-ref` reads `%00` as a NUL byte, but
// `--pretty=format:` (log, show, stash list) does not — it passes
// `%00` through as the literal text "%00". Using the wrong one here
// produced entries whose message/date/sha all parsed as empty strings,
// with no error anywhere: the request succeeded, the fields were just
// blank.
const STASH_FMT = ["%gd", "%gs", "%cr", "%H"].join("%x00");

interface StashEntry {
  /** `stash@{0}` — display only; the client addresses by `index`. */
  ref: string;
  index: number;
  message: string;
  relativeDate: string;
  sha: string;
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const root = await resolveRoot(cwd);
  if (typeof root !== "string") return root;

  const res = await runGit(
    root,
    ["stash", "list", `--pretty=format:${STASH_FMT}`],
    { timeoutMs: 5000 },
  );
  if (!res.ok) {
    return NextResponse.json({ enabled: true, entries: [] });
  }
  return NextResponse.json({ enabled: true, entries: parseList(res.stdout) });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: {
    cwd?: unknown;
    action?: unknown;
    message?: unknown;
    index?: unknown;
    includeUntracked?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const action =
    body.action === "push" ||
    body.action === "pop" ||
    body.action === "apply" ||
    body.action === "drop"
      ? body.action
      : null;
  if (!cwd || !action) {
    return NextResponse.json(
      { error: "cwd and action (push|pop|apply|drop) required" },
      { status: 400 },
    );
  }

  const message =
    typeof body.message === "string" && body.message.trim().length > 0
      ? body.message.trim()
      : null;
  if (message !== null && !isSafeCommitMessage(message)) {
    return NextResponse.json(
      { error: "invalid-message" },
      { status: 400 },
    );
  }

  // Only a non-negative integer becomes a `stash@{N}` ref. Anything
  // else (a float, a string, a negative) falls back to the default
  // entry rather than travelling into argv.
  const index =
    typeof body.index === "number" &&
    Number.isInteger(body.index) &&
    body.index >= 0 &&
    body.index < 1000
      ? body.index
      : null;
  const includeUntracked = body.includeUntracked === true;

  const root = await resolveRoot(cwd);
  if (typeof root !== "string") return root;

  const entryCount = await countEntries(root);

  const gate = confirmGate(req, { kind: "stash", action, entryCount }, root);
  if (!gate.allow) return gate.response;

  const argv = ["stash", action];
  if (action === "push") {
    if (includeUntracked) argv.push("--include-untracked");
    // `-m <msg>` is the one place a stash message enters argv. It is
    // guarded by isSafeCommitMessage (no NUL, capped length) and
    // `push` takes it as a value, not a pathspec, so a leading `-`
    // cannot be re-read as a flag.
    if (message) argv.push("-m", message);
  } else if (index !== null) {
    argv.push(`stash@{${index}}`);
  }

  const res = await runGit(root, argv, { timeoutMs: 15_000 });
  if (!res.ok) {
    const stderr = "stderr" in res ? (res.stderr ?? "") : "";
    if (stderr.includes("No local changes")) {
      return NextResponse.json(
        { error: "nothing-to-stash" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: res.error, detail: stderr || res.detail },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    action,
    note: res.stdout.trim() || res.stderr.trim() || null,
  });
}

/** Shared sandbox + is-a-repo probe. Returns the root, or a response. */
async function resolveRoot(cwd: string): Promise<string | NextResponse> {
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
  const probe = await runGit(root, ["rev-parse", "--is-inside-work-tree"], {
    timeoutMs: 2000,
  });
  if (!probe.ok || probe.stdout.trim() !== "true") {
    return NextResponse.json({ enabled: false, reason: "not-a-git-repo" });
  }
  return root;
}

async function countEntries(root: string): Promise<number> {
  const res = await runGit(root, ["stash", "list", "--pretty=format:%gd"], {
    timeoutMs: 5000,
  });
  if (!res.ok) return 0;
  return res.stdout.split("\n").filter((l) => l.trim().length > 0).length;
}

function parseList(raw: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [ref, message, relativeDate, sha] = line.split("\0");
    if (!ref) continue;
    const m = /stash@\{(\d+)\}/.exec(ref);
    out.push({
      ref,
      index: m?.[1] ? Number.parseInt(m[1], 10) : out.length,
      message: message ?? "",
      relativeDate: relativeDate ?? "",
      sha: sha ?? "",
    });
  }
  return out;
}
