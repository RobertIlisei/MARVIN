import { spawn } from "node:child_process";
import path from "node:path";

import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StatusResponse = {
  isGit: boolean;
  branch?: string | null;
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
  const root = path.resolve(cwd);

  const check = await runGit(root, ["rev-parse", "--is-inside-work-tree"], 2000);
  if (check.code !== 0 || check.stdout.trim() !== "true") {
    const body: StatusResponse = { isGit: false, status: {} };
    return NextResponse.json(body);
  }

  const [statusRes, branchRes] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1"]),
    runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], 2000),
  ]);

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
    status,
  };
  return NextResponse.json(body);
}
