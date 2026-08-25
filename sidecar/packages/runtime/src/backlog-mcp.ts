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

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { groomBacklog, renderGroomReport } from "./backlog-groom";

import {
  BACKLOG_KINDS,
  BACKLOG_SEVERITIES,
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  addBacklogItem,
  classifyBacklogText,
  listBacklog,
  resolveBacklogItem,
  setBacklogStatus,
  type BacklogItem,
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

/**
 * Render overlap candidates for the model to relay.
 *
 * Deliberately phrased as a question for the USER, not an instruction to the
 * model: overlap is a hint, and acting on it unprompted would resolve work
 * nobody agreed to drop (ADR-0044 addendum).
 */
function overlapNote(related: BacklogItem[], lead: string): string {
  if (related.length === 0) return "";
  const list = related.map((i) => `\`${i.id}\` "${i.title}" [${i.status}]`).join(", ");
  return (
    ` ${lead} ${related.length === 1 ? "1 live item looks" : `${related.length} live items look`}` +
    ` like the same work: ${list}. Mention this to the user and let THEM decide` +
    ` whether to merge or resolve — do not resolve or rewrite them yourself.`
  );
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
      force: z
        .boolean()
        .optional()
        .describe(
          "Only after a capture was refused as a near-duplicate: set true if the item really IS distinct despite the similar wording. Never set it pre-emptively.",
        ),
      body: z.string().optional().describe(`Optional: why it matters + the concrete change (≤${MAX_BODY_CHARS} chars).`),
      severity: z.enum(BACKLOG_SEVERITIES).optional().describe("low | med | high. Default med."),
      kind: z
        .enum(BACKLOG_KINDS)
        .optional()
        .describe(
          "What SORT of work: bug | feature | investigate | test | docs | chore. " +
            "SET THIS ON EVERY CAPTURE — you already judge severity, which is harder, " +
            "and you have the context for why you parked it. `investigate` is for items " +
            "whose output is a DECISION rather than a diff (verify / model / recheck). " +
            "Use `unspecified` ONLY when the item genuinely spans kinds; a best-guess " +
            "kind is one click for the user to correct, whereas an unclassified backlog " +
            "makes the filters useless (ADR-0064 addendum).",
        ),
      blocked: z
        .boolean()
        .optional()
        .describe(
          "True when the item waits on something OUTSIDE the repo — a sign-off, a " +
            "legal cutoff, a third party. Not a status: a blocked item is still open, " +
            "it just isn't pickable. Always pair with `blockedOn`.",
        ),
      blockedOn: z
        .string()
        .optional()
        .describe("What unblocks it, one line. Required in practice whenever blocked is true."),
      provisional: z
        .boolean()
        .optional()
        .describe("true = auto-capture at discovery (no go-ahead); awaits keep/dismiss at the handoff. Default false (user-confirmed)."),
    },
    async ({ title, body, severity, kind, blocked, blockedOn, provisional, force }) => {
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
        ...(force ? { force } : {}),
        ...(body ? { body } : {}),
        ...(severity ? { severity } : {}),
        ...(kind ? { kind } : {}),
        ...(blocked !== undefined ? { blocked } : {}),
        ...(blockedOn ? { blockedOn } : {}),
        ...(provisional ? { provisional } : {}),
        ...(marvinSessionId ? { sessionId: marvinSessionId } : {}),
      });
      if (!res.ok) return errorResult(res.error);
      if (res.duplicateOf) {
        return textResult(
          `NOT parked — this restates an item already open: \`${res.duplicateOf}\` ` +
            `("${res.item.title}"). Nothing was lost; that item still stands. ` +
            `If your note adds something, update THAT item's body instead of parking a ` +
            `second one. If it is genuinely different work, call \`backlog_add\` again ` +
            `with \`force: true\` and say why in the body.`,
        );
      }
      const prov = res.item.status === "provisional";
      return textResult(
        `${res.created ? "Parked" : "Updated"} backlog item \`${res.item.id}\` ` +
          `(${res.item.severity}${prov ? ", provisional" : ""}). ` +
          (prov
            ? `Auto-captured — list it at the handoff and keep/dismiss with \`backlog_resolve\`.`
            : `Surfaces next session and in the backlog panel; resolve with \`backlog_resolve\`.`) +
          (res.created && res.item.kind === "unspecified"
            ? ` It is UNCLASSIFIED — call \`backlog_add\` again with the same title and a \`kind\` ` +
              `(bug | feature | investigate | test | docs | chore), plus \`blocked\`/\`blockedOn\` if it ` +
              `waits on someone outside the repo. An unclassified item makes the user's filters useless.`
            : "") +
          overlapNote(res.related, "Possible overlap —"),
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
        (resolution === "keep"
          ? `Backlog item \`${id}\` kept (now open).`
          : `Backlog item \`${id}\` marked ${resolution}.`) +
          overlapNote(res.related ?? [], "Still open —"),
      );
    },
  );

  const groomTool = tool(
    "backlog_groom",
    "REVIEW the backlog and report what looks wrong — near-duplicates, " +
      "auto-captured items never reviewed, items untouched for weeks, references " +
      "to files that no longer exist, and HIGH-severity items left sitting. " +
      "READ-ONLY: it changes nothing. Use it when the user asks to review / tidy " +
      "/ groom the backlog, at the start of a session that will work through " +
      "parked items, or when the backlog has grown enough that the user can't " +
      "scan it. Every finding is a HEURISTIC — relay them and let the user " +
      "decide. You MUST NOT resolve, merge, re-prioritise, or edit any item on " +
      "the strength of this report alone (ADR-0063).",
    {
      staleDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days untouched before an item counts as stale. Default 30."),
      maxFindings: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap on findings returned. Default 25."),
    },
    async ({ staleDays, maxFindings }) => {
      const items = await listBacklog(cwd);
      if (items.length === 0) return textResult("Backlog is empty — nothing to groom.");
      const report = groomBacklog(items, {
        now: new Date(),
        ...(staleDays ? { staleDays } : {}),
        ...(maxFindings ? { maxFindings } : {}),
        // Resolved against the project workDir. A path that escapes the
        // project is treated as present rather than missing: we can't verify
        // it, and reporting an unverifiable path as gone would be a lie.
        fileExists: (ref) => {
          const abs = resolve(cwd, ref);
          if (!abs.startsWith(resolve(cwd) + sep)) return true;
          return existsSync(abs);
        },
      });
      return textResult(renderGroomReport(report));
    },
  );

  return createSdkMcpServer({
    name: "marvin-backlog",
    version: "1.0.0",
    // ADR-0073 — in the turn-1 prompt, never deferred behind ToolSearch.
    alwaysLoad: true,
    tools: [addTool, listTool, resolveTool, groomTool],
  });
}
