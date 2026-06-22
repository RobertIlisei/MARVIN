/**
 * marvin-backlog — in-process MCP server for the project backlog (ADR-0044).
 *
 * The model write path for `.marvin/backlog/`. Like `marvin-memory`, the value
 * is the ENFORCED boundary: `backlog_add` rejects payloads that belong elsewhere
 * (durable facts → `remember`, status → git, decisions → ADR) and caps length,
 * so the backlog can't bloat into a project journal (the ADR-0042 lesson). The
 * file logic lives in the shared `backlog.ts` store — the `/api/backlog` routes
 * (macOS UI) write through the same code.
 *
 * A PARKING LOT, not a dispatch queue (Golden Rule 1): these tools record and
 * resolve items for the single assistant + the user. Nothing here pulls work or
 * runs autonomously. Scoped to the active project's workDir.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  BACKLOG_SEVERITIES,
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  addBacklogItem,
  classifyBacklogText,
  listBacklog,
  resolveBacklogItem,
  setBacklogStatus,
  type BacklogStatus,
} from "./backlog";

export interface BacklogToolContext {
  cwd: string;
  /** Best-effort link back to the parking session; absent for non-chat callers. */
  marvinSessionId?: string | undefined;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function createBacklogMcpServer(ctx: BacklogToolContext) {
  const { cwd, marvinSessionId } = ctx;

  const addTool = tool(
    "backlog_add",
    "Park an ACTIONABLE deferred-work item to the project backlog — a follow-up, " +
      "an out-of-scope improvement, or a blocker you noticed in flight but won't " +
      "do now. AUTO-CAPTURE AT DISCOVERY (ADR-0047): the moment you notice such " +
      "an item — even mid-task, unrelated to what you're doing — call this with " +
      "`provisional: true` IMMEDIATELY (no user go-ahead needed); it parks as " +
      "provisional and you batch keep/dismiss it at the scope-met handoff. Do NOT " +
      "wait for the handoff to capture — that loses items. Omit `provisional` " +
      "(or pass false) only for an item the user has explicitly confirmed. NOT " +
      "for durable facts (→ remember), verification/commit status (→ git), or " +
      "decisions (→ ADR) — those are rejected. A parking lot the user revisits, " +
      "never an auto-executed queue.",
    {
      title: z.string().min(1).describe(`One actionable line; the dedup key (≤${MAX_TITLE_CHARS} chars).`),
      body: z.string().optional().describe(`Optional: why it matters + the concrete change (≤${MAX_BODY_CHARS} chars).`),
      severity: z.enum(BACKLOG_SEVERITIES).optional().describe("low | med | high. Default med."),
      provisional: z
        .boolean()
        .optional()
        .describe("true = auto-capture at discovery (no go-ahead); awaits keep/dismiss at the handoff. Default false (user-confirmed)."),
    },
    async ({ title, body, severity, provisional }) => {
      const cls = classifyBacklogText(title, body ?? "");
      if (!cls.ok) {
        return errorResult(
          `Rejected — this isn't an actionable backlog item (${cls.why}). The backlog ` +
            `holds deferred WORK; record facts via \`remember\`, status in git, and ` +
            `decisions in an ADR (ADR-0044).`,
        );
      }
      const res = await addBacklogItem(cwd, {
        title,
        ...(body ? { body } : {}),
        ...(severity ? { severity } : {}),
        ...(provisional ? { provisional } : {}),
        ...(marvinSessionId ? { sessionId: marvinSessionId } : {}),
      });
      if (!res.ok) return errorResult(res.error);
      const prov = res.item.status === "provisional";
      return textResult(
        `${res.created ? "Parked" : "Updated"} backlog item \`${res.item.id}\` ` +
          `(${res.item.severity}${prov ? ", provisional" : ""}). ` +
          (prov
            ? `Auto-captured — list it at the handoff and keep/dismiss with \`backlog_resolve\`.`
            : `Surfaces next session and in the backlog panel; resolve with \`backlog_resolve\`.`),
      );
    },
  );

  const listTool = tool(
    "backlog_list",
    "List backlog items, optionally filtered by status (provisional | open | " +
      "doing | done | dismissed). Use on intake, when the user asks what's " +
      "parked, and at the scope-met handoff (`status: provisional`) to batch " +
      "keep/dismiss what was auto-captured this turn.",
    {
      status: z
        .enum(["provisional", "open", "doing", "done", "dismissed"])
        .optional()
        .describe("Filter; omit for all."),
    },
    async ({ status }) => {
      const items = await listBacklog(cwd, status ? { status: status as BacklogStatus } : undefined);
      if (items.length === 0) {
        return textResult(status ? `No ${status} backlog items.` : "Backlog is empty.");
      }
      const lines = items.map(
        (i) => `- [${i.status}] (${i.severity}) ${i.title} — backlog/${i.id}.md`,
      );
      return textResult(`Backlog (${items.length}):\n${lines.join("\n")}`);
    },
  );

  const resolveTool = tool(
    "backlog_resolve",
    "Resolve or review a backlog item by id — `keep` (confirm a provisional item " +
      "→ open), `dismissed` (won't do), or `done` (completed). Use `keep`/" +
      "`dismissed` at the handoff to clear provisional auto-captures. A " +
      "done/dismissed item drops from the active index (its file is kept).",
    {
      id: z.string().min(1).describe("The item slug (from backlog_list)."),
      resolution: z.enum(["keep", "done", "dismissed"]).describe("keep (provisional → open) | done | dismissed."),
      note: z.string().optional().describe("Optional one-line note appended to the item."),
    },
    async ({ id, resolution, note }) => {
      // `keep` promotes a provisional item to open; done/dismissed are terminal.
      const res =
        resolution === "keep"
          ? await setBacklogStatus(cwd, id, "open", note)
          : await resolveBacklogItem(cwd, { id, resolution, ...(note ? { note } : {}) });
      if (!res.ok) return errorResult(res.error);
      return textResult(
        resolution === "keep"
          ? `Backlog item \`${id}\` kept (now open).`
          : `Backlog item \`${id}\` marked ${resolution}.`,
      );
    },
  );

  return createSdkMcpServer({
    name: "marvin-backlog",
    version: "1.0.0",
    tools: [addTool, listTool, resolveTool],
  });
}
