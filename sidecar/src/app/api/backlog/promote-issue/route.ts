/**
 * POST /api/backlog/promote-issue  { workDir, id }  → { ok, url } | { error }
 *
 * OPTIONAL export (ADR-0044): turn a backlog item into a GitHub issue for
 * projects that have a remote + `gh` authed. The backlog stays the source of
 * truth — this is an export target, not the store. Best-effort: any missing
 * remote / missing `gh` / auth failure returns a clear error the panel shows,
 * and the backlog item is untouched.
 *
 * CSRF-guarded + project-validated like the other mutating verbs.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { type NextRequest, NextResponse } from "next/server";
import { listBacklog, setBacklogStatus } from "@marvin/runtime/backlog";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const run = promisify(execFile);

interface Body {
  workDir?: string;
  id?: string;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const v = validateProjectCwd(body.workDir);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: v.status });
  if (!body.id?.trim()) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const item = (await listBacklog(v.workDir)).find((i) => i.id === body.id);
  if (!item) return NextResponse.json({ error: `no backlog item "${body.id}"` }, { status: 404 });

  // Remote check first — no remote means there's nowhere to file an issue.
  try {
    await run("git", ["-C", v.workDir, "remote", "get-url", "origin"]);
  } catch {
    return NextResponse.json(
      { error: "no `origin` remote — GitHub export needs a remote repo." },
      { status: 409 },
    );
  }

  try {
    const issueBody =
      `${item.body || "(no detail)"}\n\n— parked in MARVIN backlog (\`${item.id}\`, ${item.severity})`;
    const { stdout } = await run(
      "gh",
      ["issue", "create", "--title", item.title, "--body", issueBody],
      { cwd: v.workDir },
    );
    const url = stdout.trim().split("\n").pop() ?? "";
    // Record the export on the item (kept open — filing an issue isn't resolving).
    await setBacklogStatus(v.workDir, item.id, item.status, `exported → ${url}`);
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    return NextResponse.json(
      { error: `gh issue create failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
