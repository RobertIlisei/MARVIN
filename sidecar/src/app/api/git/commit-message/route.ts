/**
 * POST /api/git/commit-message — body `{ cwd, amend? }`
 *
 * Drafts a commit message from what is actually staged. This is the
 * "Generate ✨" button next to the commit box, matching the affordance
 * VS Code / Antigravity put there.
 *
 * Two design points worth keeping:
 *
 * 1. **The model gets the repo's own recent subjects.** A generated
 *    message that ignores the project's convention (`fix(prod-db): …`
 *    here, `Fix bug` elsewhere) is worse than no message, because the
 *    user has to rewrite it rather than accept it. Five recent
 *    subjects cost nothing and pin the style.
 *
 * 2. **The spawn carries `allowedTools: []`.** `runClaudeCli` always
 *    passes `--dangerously-skip-permissions`, so without that list a
 *    button labelled "write me a sentence" would be an unrestricted
 *    agent standing in the user's working tree. It needs the model and
 *    nothing else.
 *
 * 3. **It runs on the cheapest tier, not the session's model.** The
 *    executor defaults to Opus because the pair-programming loop is
 *    sequential code work; summarising a diff into one line is not.
 *    Measured on a one-line diff, the Opus draft cost **$0.22** — per
 *    button press, on a repo whose real diffs are far larger. Haiku
 *    writes the same sentence for a fraction of it. Override with
 *    `MARVIN_COMMIT_MESSAGE_MODEL` if you disagree.
 *
 * Mutates no git state, so no policy gate — but it DOES spend tokens
 * and spawn a subprocess, so it keeps the CSRF guard.
 */

import { runGit } from "@marvin/git";
import { runClaudeCli } from "@marvin/runtime";
import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { fallbackNewestOfTier } from "@marvin/runtime/models";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Diff bytes handed to the model. Beyond this the summary is the same. */
const DIFF_CAP = 60_000;

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: { cwd?: unknown; amend?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const cwd = typeof body.cwd === "string" ? body.cwd : null;
  const amend = body.amend === true;
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
    return NextResponse.json(
      { error: sandbox.ok ? "cwd is not a directory" : sandbox.error },
      { status: 400 },
    );
  }
  const root = sandbox.absolutePath;

  // `--cached` for a normal commit; `HEAD~1` for an amend, so the
  // message describes the whole rewritten commit and not just the
  // newly-staged half of it.
  const diffArgv = amend
    ? ["diff", "HEAD~1", "--no-color", "--stat", "-p"]
    : ["diff", "--cached", "--no-color", "--stat", "-p"];

  const [firstTry, subjects] = await Promise.all([
    runGit(root, diffArgv, { timeoutMs: 15_000 }),
    runGit(root, ["log", "-5", "--pretty=format:%s"], { timeoutMs: 5000 }),
  ]);

  // `runGit` caps stdout at 2 MB. A big refactor blows straight past
  // that, and "generate failed" on the commits that most need a
  // message is the wrong answer — fall back to the --stat summary,
  // which is bounded by the file count and is enough to name what
  // changed.
  let diff = firstTry;
  let statOnly = false;
  if (!diff.ok && diff.error === "buffer-overflow") {
    diff = await runGit(
      root,
      diffArgv.filter((a) => a !== "-p"),
      { timeoutMs: 15_000 },
    );
    statOnly = true;
  }

  if (!diff.ok) {
    return NextResponse.json(
      { error: "diff-failed", detail: "stderr" in diff ? diff.stderr : null },
      { status: 502 },
    );
  }
  const staged = diff.stdout.trim();
  if (!staged) {
    return NextResponse.json({ error: "nothing-staged" }, { status: 409 });
  }

  const truncated = statOnly || staged.length > DIFF_CAP;
  const excerpt = truncated ? staged.slice(0, DIFF_CAP) : staged;
  const recent = subjects.ok ? subjects.stdout.trim() : "";

  const prompt = [
    "Write a git commit message for the staged diff below.",
    "",
    "Rules:",
    "- Match the style of the recent subjects shown, including any",
    "  conventional-commit prefix they use.",
    "- Subject line: imperative mood, no trailing period, <= 72 chars.",
    "- Add a body ONLY if the change needs one; separate it with a",
    "  blank line and wrap at 72 columns.",
    "- Describe what the change does and why, not which files moved.",
    "- Output the message and nothing else — no preamble, no code",
    "  fence, no commentary.",
    ...(statOnly
      ? ["- Only the --stat summary is shown; the patch was too large."]
      : truncated
        ? ["- The diff below is truncated; the --stat header is complete."]
        : []),
    "",
    recent ? `Recent subjects in this repo:\n${recent}` : "",
    "",
    "Staged diff:",
    excerpt,
  ]
    .filter(Boolean)
    .join("\n");

  // `fallbackNewestOfTier` is provider-scoped, so this resolves to an
  // OpenRouter id when the user is on BYOK rather than sending a bare
  // Anthropic one. Null (unknown tier for the provider) falls through
  // to runClaudeCli's own default.
  const model =
    process.env.MARVIN_COMMIT_MESSAGE_MODEL?.trim() ||
    fallbackNewestOfTier("haiku") ||
    undefined;

  const result = await runClaudeCli({
    message: prompt,
    cwd: root,
    model,
    allowedTools: [],
  });

  if (!result.ok || !result.text.trim()) {
    return NextResponse.json(
      { error: "generate-failed", detail: result.error },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: cleanup(result.text),
    truncated,
    model: model ?? null,
    costUsd: result.costUsd,
  });
}

/**
 * Models fence prose more often than the prompt would suggest, and a
 * commit box is the one place a stray ``` is guaranteed to be wrong.
 * Strip a wrapping fence and any leading "Here is…" line.
 */
function cleanup(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  const lines = text.split("\n");
  if (lines.length > 1 && /^(here'?s?|sure|okay)\b/i.test(lines[0] ?? "")) {
    text = lines.slice(1).join("\n").trim();
  }
  return text;
}
