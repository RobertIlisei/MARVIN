/**
 * `marvin-supervise` — the supervisor's only acting surface (ADR-0127 §2).
 *
 * Milestone 1 ships three verbs:
 *   - `sessions` — the tabs the user delegated, with what each is waiting on;
 *   - `read`     — a delegated tab's pending question, transcript tail, plan,
 *                  or this supervisor's ledger for it (tab content wrapped as
 *                  untrusted data);
 *   - `answer`   — a proposed answer to a pending AskUserQuestion, or an
 *                  escalation of it. Evaluated by the policy and ledgered;
 *                  in shadow mode it performs NOTHING. This module imports no
 *                  function that could resolve a confirm.
 *
 * Every other verb (`send`, `cancel`, `set_posture`, `worktrees`,
 * `close_session`, `new_session`) arrives with the milestone that can classify
 * it (plan, milestones 2–5).
 *
 * Registered only in the supervisor session; the executor gate denies the
 * server's tools everywhere else (`@marvin/tools/policy`).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { getPendingConfirm } from "./confirm-registry";
import { type ModelLookup, type PosturePatch, validatePosturePatch } from "./posture";
import type { SessionWatchRow } from "./session-watch";
import { appendLedgerEntry, digestArgs, type LedgerDecision, type LedgerGround, readLedger } from "./supervisor-ledger";
import { type ActionLimiter, evaluateAnswer, evaluateSetPosture, type GroundContext, type GroundRef } from "./supervisor-policy";
import { wrapUntrusted } from "./supervisor-prompt";
import { getSupervisorState, isSupervisorSessionId } from "./supervisor-state";

export const SUPERVISE_SERVER_NAME = "marvin-supervise";
export const SUPERVISE_TOOL_NAMES = ["sessions", "read", "answer", "set_posture"] as const;

/** What the verbs read, injected so tests run on fixtures and the runtime on the real stores. */
export interface VerbDeps {
  listRows(): Promise<SessionWatchRow[]>;
  getPending: typeof getPendingConfirm;
  readTranscriptTail(marvinSessionId: string): string;
  readBrief(marvinSessionId: string): string | null;
  tabStartedAt(marvinSessionId: string): number | null;
  readPlanText(marvinSessionId: string): string;
  /** What models cost, for telling a narrowing from a widening (milestone 2). */
  modelLookup(): Promise<ModelLookup>;
}

export interface VerbContext {
  projectId: string;
  /** The project root — the main checkout grounds resolve against. */
  workDir: string;
  wakeId: string | null;
  /** Act verbs invoked in this wake, for the per-wake breaker. */
  wake: { acts: number };
  limiter: ActionLimiter;
  deps: VerbDeps;
}

export interface AnswerArgs {
  marvinSessionId: string;
  toolUseId: string;
  /** Full question text → chosen option label(s). */
  answers?: Record<string, string | string[]>;
  /** Full question text → free-text "Other" answer. */
  other?: Record<string, string>;
  grounds?: GroundRef[];
  escalate?: { reason: string; recommendation?: string };
}

export interface SetPostureArgs {
  marvinSessionId: string;
  posture: PosturePatch;
  grounds?: GroundRef[];
}

export interface ReadArgs {
  marvinSessionId: string;
  what: "question" | "transcript" | "plan" | "ledger";
  toolUseId?: string;
}

interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

function parseQuestions(input: Record<string, unknown>): Question[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs
    .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
    .map((q) => ({
      question: String(q.question ?? ""),
      ...(typeof q.header === "string" ? { header: q.header } : {}),
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .map((o) => ({ label: String(o.label ?? ""), ...(typeof o.description === "string" ? { description: o.description } : {}) })),
    }));
}

/** Null when the answer fits the question; otherwise why not. */
function validateAnswers(qs: Question[], answers: Record<string, string | string[]>, other: Record<string, string>): string | null {
  const known = new Map(qs.map((q) => [q.question, q]));
  const keys = [...new Set([...Object.keys(answers), ...Object.keys(other)])];
  if (keys.length === 0) return "no answer given";
  for (const k of keys) {
    const q = known.get(k);
    if (!q) return `"${k.slice(0, 80)}" is not one of the pending questions`;
    const picked = answers[k] === undefined ? [] : Array.isArray(answers[k]) ? (answers[k] as string[]) : [answers[k] as string];
    const free = other[k];
    if (free !== undefined && (typeof free !== "string" || !free.trim() || free.length > 2_000)) return `the "Other" answer to "${k.slice(0, 80)}" must be 1–2000 characters`;
    if (!q.multiSelect && picked.length + (free !== undefined ? 1 : 0) > 1) return `"${k.slice(0, 80)}" takes one answer`;
    for (const label of picked) {
      if (!q.options.some((o) => o.label === label)) {
        return `"${label}" is not an option of "${k.slice(0, 80)}" (options: ${q.options.map((o) => o.label).join(", ")})`;
      }
    }
  }
  return null;
}

const REPLY: Record<LedgerDecision, (reason: string) => string> = {
  propose: () =>
    "Recorded as a proposal (shadow mode). Nothing was answered — the question stays pending for the user, and your proposal is compared with their answer later.",
  act: () => "Recorded. Performing answers arrives in a later milestone — nothing was answered; the question stays pending.",
  escalate: (r) => `Escalated to the user: ${r}. The question stays pending for them.`,
  refuse: (r) => `Refused: ${r}.`,
  drop: (r) => `Dropped: ${r}.`,
};

export function createSupervisorVerbs(ctx: VerbContext) {
  const { projectId } = ctx;

  const visible = (id: string) => !isSupervisorSessionId(id) && !!getSupervisorState(projectId).delegation[id];

  async function sessions(): Promise<string> {
    const st = getSupervisorState(projectId);
    const rows = await ctx.deps.listRows();
    const out = rows
      .filter((r) => visible(r.marvinSessionId))
      .map((r) => ({
        marvinSessionId: r.marvinSessionId,
        title: r.title,
        delegation: st.delegation[r.marvinSessionId],
        state: r.state,
        pending: r.pending.map((p) => ({
          turnId: p.turnId,
          toolUseId: p.toolUseId,
          toolName: p.toolName,
          raisedBy: p.raisedBy ?? null,
          excerpt: p.excerpt ?? null,
          since: p.since,
        })),
        plan: r.plan,
        lastTurn: r.lastTurn ? r.lastTurn.outcome : null,
      }));
    return JSON.stringify(out, null, 2);
  }

  async function read(args: ReadArgs): Promise<string> {
    const tab = String(args.marvinSessionId ?? "").trim();
    if (!visible(tab)) return `Refused: tab ${tab} is not delegated to you (or is a supervisor session).`;
    switch (args.what) {
      case "question": {
        const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
        const p = row?.turn && args.toolUseId ? ctx.deps.getPending(row.turn.turnId, args.toolUseId) : null;
        if (!p || p.raisedBy !== "ask-user-question") return `No pending question ${args.toolUseId ?? "(none given)"} on tab ${tab}.`;
        return wrapUntrusted("question", tab, JSON.stringify(parseQuestions(p.originalInput), null, 2));
      }
      case "transcript":
        return wrapUntrusted("transcript", tab, ctx.deps.readTranscriptTail(tab));
      case "plan": {
        const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
        const head = row?.plan
          ? `${row.plan.total} step(s), ${row.plan.done} done, ${row.plan.seeded ? "seeded from the user's brief" : "presented by the tab"}`
          : "no plan";
        return `${head}\n${wrapUntrusted("plan", tab, ctx.deps.readPlanText(tab))}`;
      }
      case "ledger": {
        const lines = readLedger(projectId, { tab, limit: 20 }).map(
          (e) => `- ${e.at} ${e.kind}/${e.verb}${e.decision ? ` → ${e.decision}` : ""}: ${e.reason}`,
        );
        return lines.length ? lines.join("\n") : "(no ledger entries for this tab)";
      }
      default:
        return "Refused: `what` must be question, transcript, plan or ledger.";
    }
  }

  async function answer(args: AnswerArgs): Promise<string> {
    const st = getSupervisorState(projectId);
    const tab = String(args.marvinSessionId ?? "").trim();
    const toolUseId = String(args.toolUseId ?? "").trim();
    const argsDigest = digestArgs({ toolUseId, answers: args.answers ?? {}, other: args.other ?? {}, escalate: args.escalate ?? null });
    const log = (decision: LedgerDecision, reason: string, extra: { grounds?: LedgerGround[]; heuristic?: string } = {}) => {
      appendLedgerEntry(projectId, {
        kind: "verb",
        verb: "answer",
        tab: tab || null,
        wakeId: ctx.wakeId,
        mode: st.mode,
        decision,
        reason,
        argsDigest,
        grounds: extra.grounds ?? [],
        ...(extra.heuristic ? { heuristic: extra.heuristic } : {}),
      });
      return REPLY[decision](reason);
    };

    if (isSupervisorSessionId(tab)) return log("refuse", "a supervisor session is never a target (no recursion)");
    const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
    if (!row) return log("refuse", `no open tab ${tab}`);
    const pending = row.turn && toolUseId ? ctx.deps.getPending(row.turn.turnId, toolUseId) : null;
    if (!pending || pending.raisedBy !== "ask-user-question") {
      const why = pending ? ` — that confirm was raised by the ${pending.raisedBy ?? "unknown"} rule, not a question` : "";
      return log("refuse", `no pending question ${toolUseId} on tab ${tab}${why}`);
    }
    const questions = parseQuestions(pending.originalInput);
    if (!args.escalate) {
      const bad = validateAnswers(questions, args.answers ?? {}, args.other ?? {});
      if (bad) return log("refuse", bad);
    }
    const key = `answer:${toolUseId}`;
    const gate = ctx.limiter.check(projectId, tab, key, ctx.wake.acts);
    if (!gate.ok) return log("drop", gate.reason);
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, tab, key);

    const outcome = evaluateAnswer({
      mode: st.mode,
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      questionTexts: questions.flatMap((q) => [q.question, q.header ?? "", ...q.options.flatMap((o) => [o.label, o.description ?? ""])]),
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: {
        mainRoot: ctx.workDir,
        tabRoot: row.tree.mode === "worktree" ? row.tree.path : null,
        charter: st.charter,
        brief: ctx.deps.readBrief(tab),
        planStepCount: row.plan?.total ?? 0,
        planSeeded: row.plan?.seeded ?? false,
        tabStartedAt: ctx.deps.tabStartedAt(tab),
      },
      ...(args.escalate ? { escalate: { reason: String(args.escalate.reason ?? "").slice(0, 500) } } : {}),
    });
    const rec = args.escalate?.recommendation ? ` — recommendation: ${String(args.escalate.recommendation).slice(0, 500)}` : "";
    return log(outcome.decision, `${outcome.reason}${rec}`, {
      grounds: outcome.grounds,
      ...(outcome.heuristic ? { heuristic: outcome.heuristic } : {}),
    });
  }

  /** Milestone 2 — a narrowing is proposed, a widening escalates; in shadow nothing changes. */
  async function set_posture(args: SetPostureArgs): Promise<string> {
    const st = getSupervisorState(projectId);
    const tab = String(args.marvinSessionId ?? "").trim();
    const argsDigest = digestArgs({ posture: args.posture ?? {} });
    const log = (decision: LedgerDecision, reason: string, grounds: LedgerGround[] = []) => {
      appendLedgerEntry(projectId, { kind: "verb", verb: "set_posture", tab: tab || null, wakeId: ctx.wakeId, mode: st.mode, decision, reason, argsDigest, grounds });
      return decision === "propose"
        ? "Recorded as a proposal (shadow mode). The tab's posture is unchanged; your proposal is compared with what the user does later."
        : REPLY[decision](reason);
    };
    if (isSupervisorSessionId(tab)) return log("refuse", "a supervisor session is never a target (no recursion)");
    const row = (await ctx.deps.listRows()).find((r) => r.marvinSessionId === tab);
    if (!row?.posture) return log("refuse", `no open tab ${tab} with a recorded posture`);
    const valid = validatePosturePatch(args.posture);
    if (!valid.ok) return log("refuse", valid.error);
    const key = `set_posture:${argsDigest}`;
    const gate = ctx.limiter.check(projectId, tab, key, ctx.wake.acts);
    if (!gate.ok) return log("drop", gate.reason);
    ctx.wake.acts += 1;
    ctx.limiter.record(projectId, tab, key);
    const outcome = evaluateSetPosture({
      mode: st.mode,
      delegation: st.delegation[tab],
      targetIsSupervisor: false,
      from: row.posture,
      patch: valid.patch,
      lookup: await ctx.deps.modelLookup(),
      grounds: Array.isArray(args.grounds) ? args.grounds : [],
      groundCtx: groundContextFor(row, st.charter),
    });
    return log(outcome.decision, outcome.reason, outcome.grounds);
  }

  function groundContextFor(row: SessionWatchRow, charter: string): GroundContext {
    return {
      mainRoot: ctx.workDir,
      tabRoot: row.tree.mode === "worktree" ? row.tree.path : null,
      charter,
      brief: ctx.deps.readBrief(row.marvinSessionId),
      planStepCount: row.plan?.total ?? 0,
      planSeeded: row.plan?.seeded ?? false,
      tabStartedAt: ctx.deps.tabStartedAt(row.marvinSessionId),
    };
  }

  return { sessions, read, answer, set_posture };
}

const groundSchema = z.object({
  kind: z.enum(["plan", "dod", "adr", "memory", "charter", "file"]),
  ref: z.string().min(1).max(500),
});

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function supervisorToolDefs(ctx: VerbContext) {
  const v = createSupervisorVerbs(ctx);
  return [
    tool(
      "sessions",
      "List the tabs the user delegated to you, with what each is waiting on (pending questions and confirms, " +
        "plan progress, last turn). Tabs not delegated, and supervisor sessions, are never listed.",
      {},
      async () => text(await v.sessions()),
    ),
    tool(
      "read",
      "Read one delegated tab: its pending question (`what: question` + `toolUseId`), its transcript tail, its plan, " +
        "or your own ledger for it. Tab content comes back wrapped as untrusted data.",
      {
        marvinSessionId: z.string().min(1),
        what: z.enum(["question", "transcript", "plan", "ledger"]),
        toolUseId: z.string().optional(),
      },
      async (args) => text(await v.read(args)),
    ),
    tool(
      "answer",
      "Answer a tab's pending AskUserQuestion, or escalate it to the user. `answers` maps the full question text to " +
        "the option label (an array for multi-select); `other` gives free text. Cite `grounds` — every answer needs " +
        "at least one the tab did not write itself. If you cannot ground it, pass `escalate: { reason, recommendation }` " +
        "instead. In shadow mode nothing is answered: your answer is recorded as a proposal.",
      {
        marvinSessionId: z.string().min(1),
        toolUseId: z.string().min(1),
        answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        other: z.record(z.string(), z.string()).optional(),
        grounds: z.array(groundSchema).max(10).optional(),
        escalate: z.object({ reason: z.string().min(1).max(500), recommendation: z.string().max(500).optional() }).optional(),
      },
      async (args) => text(await v.answer(args as AnswerArgs)),
    ),
    tool(
      "set_posture",
      "Propose a change to a tab's posture (model, thinkingMode, permissionStrategy, mode). You may only NARROW " +
        "(gated over auto over full; ask/plan over agent; lower effort; a model known to cost no more): any widening " +
        "escalates to the user, Plan → Agent included. Cite `grounds`. In shadow mode nothing changes.",
      {
        marvinSessionId: z.string().min(1),
        posture: z.object({
          model: z.string().optional(),
          thinkingMode: z.string().optional(),
          permissionStrategy: z.enum(["gated", "auto", "full"]).optional(),
          mode: z.enum(["ask", "plan", "agent"]).optional(),
        }),
        grounds: z.array(groundSchema).max(10).optional(),
      },
      async (args) => text(await v.set_posture(args as SetPostureArgs)),
    ),
  ];
}

export function createSupervisorMcpServer(ctx: VerbContext) {
  return createSdkMcpServer({
    name: SUPERVISE_SERVER_NAME,
    version: "1.0.0",
    // The supervisor's canUseTool admits no ToolSearch, so a deferred tool set
    // would leave it unable to act at all.
    alwaysLoad: true,
    tools: supervisorToolDefs(ctx),
  });
}
