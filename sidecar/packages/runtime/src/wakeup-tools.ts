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
  cancelBackgroundJob,
  listBackgroundJobs,
  MAX_JOBS_PER_SESSION,
  startBackgroundJob,
} from "./background-jobs";

import {
  cancelWakeup,
  listWakeups,
  MAX_DELAY_SECONDS,
  MAX_PENDING_PER_SESSION,
  MIN_DELAY_SECONDS,
  scheduleWakeup,
} from "./wakeup-scheduler";
import { createWorktree, describeWorktree, mergeWorktree, reconcileWorktrees, removeWorktree, sweepWorktrees } from "./worktrees";

/** Per-turn identity + config the wakeup tools capture for the future turn. */
export interface WakeupToolContext {
  marvinSessionId: string;
  projectId: string;
  cwd: string;
  model: string;
  advisorModel: string | null;
  personality: "marvin" | "neutral" | "ultron";
  permissionStrategy: "auto" | "gated";
  /** Opt-in Playwright MCP (ADR-0045); the fired turn inherits this turn's toggle. */
  playwrightEnabled?: boolean | undefined;
  thinkingMode: string;
  /** Advisor-specific effort (ADR-0033); undefined = follow the executor. */
  advisorThinkingMode?: string | undefined;
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
          "The instruction the fired turn runs, e.g. 'Check whether the `npm run build` started earlier succeeded; if it failed, read the error and fix it.' Keep it to the instruction — the fired turn already has the session; it does not need the history restated.",
        ),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe(
          "Reasoning effort for the FIRED turn. Omit to keep the current setting. Use 'low' or 'medium' when the fired turn only checks and reports (did the build pass? is the deploy green?); keep the default when it continues implementation. Can only lower the effort below the user's setting, never raise it.",
        ),
    },
    async ({ delaySeconds, reason, prompt, effort }) => {
      const result = scheduleWakeup({
        marvinSessionId: ctx.marvinSessionId,
        projectId: ctx.projectId,
        cwd: ctx.cwd,
        model: ctx.model,
        advisorModel: ctx.advisorModel,
        personality: ctx.personality,
        permissionStrategy: ctx.permissionStrategy,
        ...(ctx.playwrightEnabled !== undefined ? { playwrightEnabled: ctx.playwrightEnabled } : {}),
        thinkingMode: ctx.thinkingMode,
        advisorThinkingMode: ctx.advisorThinkingMode,
        effort,
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

  // ── Background jobs with event-based completion wakeups (ADR-0038) ──────

  const runJobTool = tool(
    "run_background_job",
    `Run a long-running shell command in the background and get a REAL follow-up turn when it FINISHES. Use this for anything that outlives a normal turn — builds, full test suites, installs, deploys, data jobs — INSTEAD of backgrounding with shell '&' / nohup (the gate denies those: nothing watches them, so you'd never hear back and would forget). Returns immediately with a job id; END YOUR TURN. When the process exits, a new turn starts automatically with the command's exit code + output tail, so you can react (fix a failure, or continue on success). For SHORT commands, just run them in the foreground and wait for the result instead. At most ${MAX_JOBS_PER_SESSION} concurrent jobs per session.`,
    {
      command: z
        .string()
        .min(1)
        .describe("The shell command to run, e.g. 'pnpm build' or 'npx playwright test'."),
      reason: z
        .string()
        .min(1)
        .describe("Short human reason, e.g. 'production build'. Shown to the user."),
    },
    async ({ command, reason }) => {
      const result = startBackgroundJob({
        command,
        reason,
        ctx: {
          marvinSessionId: ctx.marvinSessionId,
          projectId: ctx.projectId,
          cwd: ctx.cwd,
          model: ctx.model,
          advisorModel: ctx.advisorModel,
          personality: ctx.personality,
          permissionStrategy: ctx.permissionStrategy,
          thinkingMode: ctx.thinkingMode,
          advisorThinkingMode: ctx.advisorThinkingMode,
          depth: ctx.depth,
        },
      });
      if (!result.ok) return textResult(`Could not start background job: ${result.error}`);
      return textResult(
        `Background job started (id ${result.id}, pid ${result.pid}): \`${command}\`. END THE TURN now — when it finishes, a new turn will start automatically with the result. Do NOT narrate watching it; the completion turn is real.`,
      );
    },
  );

  const listJobsTool = tool(
    "list_background_jobs",
    "List this session's running background jobs (id, command, pid).",
    {},
    async () => {
      const jobs = listBackgroundJobs(ctx.marvinSessionId);
      if (jobs.length === 0) return textResult("No background jobs running for this session.");
      const lines = jobs.map((j) => `- ${j.id} (pid ${j.pid}) — \`${j.command}\` — "${j.reason}"`);
      return textResult(`Running background jobs (${jobs.length}):\n${lines.join("\n")}`);
    },
  );

  const cancelJobTool = tool(
    "cancel_background_job",
    "Stop a running background job by id (from run_background_job or list_background_jobs). No completion turn fires for a cancelled job.",
    { id: z.string().min(1).describe("The job id to cancel.") },
    async ({ id }) => {
      const ok = cancelBackgroundJob(id);
      return textResult(ok ? `Cancelling background job ${id}.` : `No running job with id ${id}.`);
    },
  );

  // ADR-0081 — worktrees for implementer subagents. MARVIN creates and names
  // them (never the subagent), dispatches an `implementer` with the path in
  // its prompt, and the gate confines that agent's writes to the tree.
  const worktreeCreate = tool(
    "worktree_create",
    "Create an isolated git worktree for ONE bounded implementation task, on a fresh branch cut from the current HEAD (ADR-0081). Returns the absolute path and branch. Then dispatch an `implementer` subagent whose prompt states that path verbatim — the permission gate binds the agent to it and allows writes ONLY there. Use when two or more independent implementation tasks can run at once, or to keep building while you continue other work. The result is a branch the USER merges; nothing merges automatically.",
    {
      task: z.string().min(3).max(200).describe("One line: what the implementer will build. Becomes the branch/directory slug."),
    },
    async ({ task }) => {
      try {
        const rec = createWorktree(ctx.cwd, task);
        return { content: [{ type: "text", text: `Worktree ready.\npath: ${rec.path}\nbranch: ${rec.branch}\nbase: ${rec.base}\n\nDispatch: Agent { subagent_type: "implementer", prompt: "Your worktree is ${rec.path} (branch ${rec.branch}). Task: ${task} …" }` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `worktree_create failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    },
  );
  const worktreeList = tool(
    "worktree_list",
    "List this project's implementer worktrees with their DERIVED state — running / empty / ready / merged — plus commits, files changed, and whether the checkout holds uncommitted work. State is recomputed from git on every call, so a branch you merged in a terminal or in another session shows as `merged` here. Use it to report finished work: `ready` is the deliverable, and `git diff <base>...<branch>` reviews it.",
    {},
    async () => {
      const all = reconcileWorktrees(ctx.cwd);
      if (all.length === 0) return textResult("No worktrees registered.");
      const ready = all.filter((w) => w.state === "ready").length;
      const lines = all.map((w) => describeWorktree(ctx.cwd, w));
      const hint = ready > 0
        ? `\n\n${ready} branch(es) ready. Merge locally with worktree_merge — that costs no CI run, because the commits ride along in whatever pipeline the current branch already runs. Never push an implementer branch on its own.`
        : "";
      return textResult(`${lines.join("\n")}${hint}`);
    },
  );
  const worktreeMerge = tool(
    "worktree_merge",
    "Merge ONE ready implementer branch into the current branch of the main tree, locally. Never pushes and never opens a PR/MR — the commits ride along in whatever pipeline the current branch was already going to run, so N branches cost zero extra CI. Refuses if the implementer is still running, the branch is empty or already merged, the main tree is dirty, or the merge conflicts (it aborts cleanly). After merging, the checkout and branch are reclaimed by worktree_sweep.",
    { slug: z.string().min(1).describe("The worktree slug from worktree_list.") },
    async ({ slug }) => {
      const out = mergeWorktree(ctx.cwd, slug);
      return out.ok ? textResult(out.message) : { content: [{ type: "text" as const, text: out.message }], isError: true };
    },
  );
  const worktreeSweep = tool(
    "worktree_sweep",
    "Reclaim every worktree that is provably safe to remove: branches with no commits, and branches already merged somewhere. Deletes the checkout AND the branch for those. NEVER touches a `ready` branch, a running implementer, or any checkout holding uncommitted work. Run it after merging, or when the user asks about leftover worktrees.",
    {},
    async () => {
      const swept = sweepWorktrees(ctx.cwd);
      if (swept.length === 0) return textResult("Nothing to reclaim — no empty or merged worktrees.");
      return textResult(swept.map((s) => `${s.slug} (${s.state}): ${s.reason}`).join("\n"));
    },
  );
  const worktreeRemove = tool(
    "worktree_remove",
    "Remove a worktree CHECKOUT after the user has merged or rejected its branch. The branch itself is kept — deleting it is the user's call. REFUSES a worktree whose implementer is still running; `force` overrides that and discards whatever it had not committed, so only pass it when the user asked.",
    {
      slug: z.string().min(1).describe("The worktree slug from worktree_list."),
      force: z.boolean().optional().describe("Remove even if the implementer is still running. Discards its uncommitted work."),
    },
    async ({ slug, force }) => {
      const out = removeWorktree(ctx.cwd, slug, force === true ? { force: true } : undefined);
      if (out.refused) return { content: [{ type: "text" as const, text: out.refused }], isError: true };
      const rec = out.removed;
      return { content: [{ type: "text", text: rec ? `Removed checkout ${rec.path}; branch ${rec.branch} kept.` : `No worktree named ${slug}.` }] };
    },
  );

  return createSdkMcpServer({
    name: "marvin-control",
    version: "0.0.1",
    // ADR-0073 — in the turn-1 prompt, never deferred behind ToolSearch. The
    // checkback guard (ADR-0055) relies on `schedule_wakeup` being callable
    // without a discovery step; a deferred tool is an unarmed promise.
    alwaysLoad: true,
    tools: [scheduleTool, cancelTool, listTool, runJobTool, listJobsTool, cancelJobTool, worktreeCreate, worktreeList, worktreeMerge, worktreeSweep, worktreeRemove],
  });
}
