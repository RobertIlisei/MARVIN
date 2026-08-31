import { spawn } from "node:child_process";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatusResponse = {
  isGit: boolean;
  branch?: string | null;
  /** `origin/main`, or null when the branch tracks nothing. */
  upstream?: string | null;
  /** Commits on HEAD not on the upstream; 0 when there is no upstream. */
  ahead?: number;
  /** Commits on the upstream not on HEAD. */
  behind?: number;
  /** Absolute path → two-char porcelain code ("M ", " M", "??", etc.) trimmed. */
  status: Record<string, string>;
};

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd });
    let stdout = "";
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    p.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    p.on("close", (code) => {
      clearTimeout(to);
      resolve({ stdout, code: timedOut ? -1 : (code ?? 0) });
    });
    p.on("error", () => {
      clearTimeout(to);
      resolve({ stdout, code: -1 });
    });
  });
}

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  if (!cwd) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const sandbox = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!sandbox.ok || !sandbox.isDirectory) {
    const body: StatusResponse = { isGit: false, status: {} };
    return NextResponse.json(body);
  }
  const root = sandbox.absolutePath;

  const check = await runGit(root, ["rev-parse", "--is-inside-work-tree"], 2000);
  if (check.code !== 0 || check.stdout.trim() !== "true") {
    const body: StatusResponse = { isGit: false, status: {} };
    return NextResponse.json(body);
  }

  // The tracking counts ride along on the poll that already runs every
  // 15 s. The status bar needs them to render "3↓ 5↑" next to the
  // branch, and a second poller for two integers would double the git
  // spawns for nothing.
  //
  // `rev-list --left-right --count HEAD...@{u}` prints "<ahead>\t<behind>"
  // in ONE call; it exits non-zero when there is no upstream, which is
  // how we detect that case without a separate probe.
  const [statusRes, branchRes, upstreamRes, trackRes] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1"]),
    runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], 2000),
    runGit(root, ["rev-parse", "--abbrev-ref", "@{u}"], 2000),
    runGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"], 3000),
  ]);

  let ahead = 0;
  let behind = 0;
  if (trackRes.code === 0) {
    const [a, b] = trackRes.stdout.trim().split(/\s+/);
    ahead = Number.parseInt(a ?? "0", 10) || 0;
    behind = Number.parseInt(b ?? "0", 10) || 0;
  }

  const status: Record<string, string> = {};
  for (const line of statusRes.stdout.split("\n")) {
    if (!line) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    let fp = rest;
    if (rest.includes(" -> ")) {
      const parts = rest.split(" -> ");
      fp = parts[1] ?? rest;
    }
    const abs = path.resolve(root, fp);
    status[abs] = xy.trim() || xy;
  }

  const body: StatusResponse = {
    isGit: true,
    branch: branchRes.code === 0 ? branchRes.stdout.trim() : null,
    upstream: upstreamRes.code === 0 ? upstreamRes.stdout.trim() : null,
    ahead,
    behind,
    status,
  };
  return NextResponse.json(body);
}
