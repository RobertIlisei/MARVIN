/**
 * `marvin-control` MCP server — the tools MARVIN calls to schedule its own
 * follow-up turns instead of *narrating* a "Monitor armed, I'll check back"
 * promise it can't keep (ADR-0031).
 *
 * Built per-turn in `runAgent`, closing over the current turn's identity +
 * config so a fired wakeup resumes the right session under the same posture.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  MAX_DELAY_SECONDS,
  MAX_PENDING_PER_SESSION,
  MIN_DELAY_SECONDS,
  cancelWakeup,
  listWakeups,
  scheduleWakeup,
} from "./wakeup-scheduler";

/** Per-turn identity + config the wakeup tools capture for the future turn. */
export interface WakeupToolContext {
  marvinSessionId: string;
  projectId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral";
  permissionStrategy: "auto" | "gated";
  thinkingMode: string;
  /** Depth of THIS turn in a wakeup chain (0 if started by a human). */
  depth: number;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function fmtFireAt(fireAt: number): string {
  const secs = Math.round((fireAt - Date.now()) / 1000);
  return `${new Date(fireAt).toISOString()} (~${secs}s from now)`;
}

export function createWakeupMcpServer(ctx: WakeupToolContext) {
  const scheduleTool = tool(
    "schedule_wakeup",
    `Schedule a REAL future turn for yourself. Use this whenever you would otherwise say "I'll check back in N minutes", "monitoring the build", or "I'll continue when it reports" — those are narration; this is the mechanism that actually fires. After the delay, a new turn starts automatically, resuming this session, with \`prompt\` as the instruction. Time-based only: delay is ${MIN_DELAY_SECONDS}-${MAX_DELAY_SECONDS}s (1 min – 24 h). At most ${MAX_PENDING_PER_SESSION} pending per session. The fired turn costs tokens like any turn, so pick a sensible delay (e.g. one check after a build's expected duration, not a tight poll).`,
    {
      delaySeconds: z
        .number()
        .int()
        .min(MIN_DELAY_SECONDS)
        .max(MAX_DELAY_SECONDS)
        .describe("Seconds from now to wake up. 60–86400 (1 min – 24 h)."),
      reason: z
        .string()
        .min(1)
        .describe("Short human reason, e.g. 'check build status'. Shown to the user."),
      prompt: z
        .string()
        .min(1)
        .describe(
          "The instruction the fired turn runs, e.g. 'Check whether the `npm run build` started earlier succeeded; if it failed, read the error and fix it.' Write it so a fresh turn knows exactly what to do.",
        ),
    },
    async ({ delaySeconds, reason, prompt }) => {
      const result = scheduleWakeup({
        marvinSessionId: ctx.marvinSessionId,
        projectId: ctx.projectId,
        cwd: ctx.cwd,
        model: ctx.model,
        advisorModel: ctx.advisorModel,
        personality: ctx.personality,
        permissionStrategy: ctx.permissionStrategy,
        thinkingMode: ctx.thinkingMode,
        delaySeconds,
        reason,
        prompt,
        schedulingDepth: ctx.depth,
      });
      if (!result.ok) {
        return textResult(`Could not schedule wakeup: ${result.error}`);
      }
      return textResult(
        `Wakeup scheduled (id ${result.record.id}). It will fire at ${fmtFireAt(
          result.record.fireAt,
        )} and run: "${reason}". Tell the user it's armed and end the turn — do NOT narrate watching; the turn really will start on its own.`,
      );
    },
  );

  const cancelTool = tool(
    "cancel_wakeup",
    "Cancel a pending scheduled wakeup by id (from schedule_wakeup or list_wakeups).",
    { id: z.string().min(1).describe("The wakeup id to cancel.") },
    async ({ id }) => {
      const ok = cancelWakeup(id, ctx.projectId);
      return textResult(
        ok ? `Cancelled wakeup ${id}.` : `No pending wakeup with id ${id}.`,
      );
    },
  );

  const listTool = tool(
    "list_wakeups",
    "List this session's pending scheduled wakeups (id, fire time, reason).",
    {},
    async () => {
      const pending = listWakeups({ marvinSessionId: ctx.marvinSessionId });
      if (pending.length === 0) return textResult("No pending wakeups for this session.");
      const lines = pending.map(
        (w) => `- ${w.id} — fires ${fmtFireAt(w.fireAt)} — "${w.reason}"`,
      );
      return textResult(`Pending wakeups (${pending.length}):\n${lines.join("\n")}`);
    },
  );

  return createSdkMcpServer({
    name: "marvin-control",
    version: "0.0.1",
    tools: [scheduleTool, cancelTool, listTool],
  });
}
