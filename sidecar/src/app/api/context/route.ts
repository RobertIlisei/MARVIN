import { approxTokens, buildProjectContext } from "@marvin/project-context";
import { contextWindowFor } from "@marvin/runtime/models";
import {
  buildSystemPrompt,
  type PersonalityMode,
} from "@marvin/runtime/personality";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Coarse estimate of the tool-schema footprint the Agent SDK injects every
 * turn: the built-in tool set (Read / Write / Edit / Bash / Grep / Glob /
 * Task / WebFetch / WebSearch / NotebookEdit / TodoWrite …) plus MARVIN's MCP
 * tools (marvin-graph ×6, marvin-memory ×2). The SDK does not expose the exact
 * serialized schemas, so this is a fixed figure — surfaced as an estimate in
 * the panel. ~11K tokens is typical for the full Claude Code tool set.
 */
const TOOLS_TOKEN_ESTIMATE = 11_000;

/**
 * GET /api/context?workDir=…&model=…&personality=…
 *
 * Powers the status-bar context panel. Returns the model's context-window size
 * plus a per-category ESTIMATE of the fixed prompt prefix (system prompt,
 * tools, project-context sections). The exact resident-token total and the
 * transcript remainder are computed client-side from the live SDK usage — the
 * headline number is exact; these category figures are length/4 estimates.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const workDir = params.get("workDir")?.trim();
  const model = params.get("model")?.trim() || null;
  const personality: PersonalityMode =
    params.get("personality") === "neutral" ? "neutral" : "marvin";

  if (!workDir) {
    return NextResponse.json({ error: "workDir is required" }, { status: 400 });
  }
  const check = validateProjectCwd(workDir);
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }

  const systemPrompt = approxTokens(buildSystemPrompt(personality));
  const pc = await buildProjectContext({
    workDir: check.workDir,
    firstMessage: true,
  }).catch(() => ({ text: "", breakdown: [] }));

  return NextResponse.json(
    {
      model,
      contextWindow: contextWindowFor(model),
      estimate: {
        systemPrompt,
        tools: TOOLS_TOKEN_ESTIMATE,
        projectContext: {
          total: approxTokens(pc.text),
          sections: pc.breakdown,
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
