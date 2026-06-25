import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { buildProjectContext } from "@marvin/project-context";
import {
  maybeRefreshGraphify,
  maybeRefreshKnowledgeGraph,
} from "@marvin/graphify-bridge";
import { defaultModel } from "@marvin/runtime/claude-cli";
import { buildSystemPrompt, type PersonalityMode } from "@marvin/runtime/personality";
import { formatActiveSkillsBlock } from "@marvin/runtime/skill-enablement";
import { slugifyWorkDir, validateProjectCwd } from "@marvin/runtime/projects";
import {
  type AgentMode,
  type PermissionStrategy,
  type RuntimeMode,
  resolveRuntimeMode,
} from "@marvin/runtime/sdk-runner";
import { appendSessionTurn, lastSdkSessionId } from "@marvin/runtime/session";
import {
  emitTurnEvent,
  getLiveTurn,
  registerLiveTurn,
} from "@marvin/runtime/turn-registry";
import type { NextRequest } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";
import { runDetachedTurn } from "@/lib/turn-orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatRequestBody {
  message: string;
  /** Active project working directory — where the CLI runs. */
  cwd?: string;
  /** Logical project identifier for session persistence. Defaults to a slug
   *  derived from `cwd`. */
  projectId?: string;
  /** Resume a previous Claude CLI session (omit to start a new one). */
  sessionId?: string;
  /** Resume a previous MARVIN session transcript (omit for new). */
  marvinSessionId?: string;
  personality?: PersonalityMode;
  /** Explicit executor model. Wins over runtimeMode if both supplied. */
  model?: string;
  /** Explicit advisor model. Enables the SDK's server-side advisor tool. */
  advisorModel?: string;
  /** Convenience alias for executor+advisor pair — used only when `model`
   *  and `advisorModel` are not explicitly set. */
  runtimeMode?: RuntimeMode;
  /** Permission strategy. `auto` (default) = full bypass, no confirm gate.
   *  `gated` = Edit/Write/unsafe Bash render a confirm card. */
  permissionStrategy?: PermissionStrategy;
  /** Opt-in Playwright MCP browser server for this turn (ADR-0045). */
  playwrightEnabled?: boolean;
  /** ADR-0051 — compact snapshot of the active plan + live per-step status,
   *  built client-side from the plan strip. Injected into the SDK prompt as a
   *  `<system-reminder>` suffix so the model stays plan-aware; never persisted
   *  to `turn.user`. Absent when no plan is active. */
  planContext?: string;
  /** Autonomy mode (ADR-0036). `agent` (default) = full autonomy; `ask` =
   *  read-only; `plan` = plan-first, approval-gated. */
  mode?: AgentMode;
  /** Reasoning-effort selection — ladder value (low/medium/high/xhigh/max)
   *  or legacy fast/thinking/max alias. Maps to SDK `effort`. */
  thinkingMode?: string;
  /** Reasoning effort for the ADVISOR subagent, independent of the
   *  executor's (ADR-0033). Same ladder values; omitted = follow the
   *  executor's effort. */
  advisorThinkingMode?: string;
  /** When true, skip the PROJECT_STATUS/BUSINESS_OVERVIEW/probe injection. */
  skipProjectContext?: boolean;
  /**
   * When true, ignore the auto-resume lookup and start the next SDK
   * turn with a fresh server-side session — i.e. drop the cumulative
   * cache that's making decisions slow — while preserving the
   * `marvinSessionId` (transcript identity) so the chat history stays
   * intact in the UI. The client surfaces this as a "Reset context"
   * affordance on the AppStatusBar context indicator. ADR-0022 §3
   * follow-up.
   */
  resetSdkSession?: boolean;
}

/**
 * POST /api/chat — start a turn.
 *
 * The HTTP response streams Server-Sent Events for the caller, but the
 * underlying agent is **decoupled from the request lifecycle** via
 * `@marvin/runtime/turn-registry`. Closing the browser tab no longer
 * kills the turn — a reconnecting client tails the same in-memory bus
 * via `GET /api/chat/resume?marvinSessionId=…`, and the transcript on
 * disk lets the client rebuild whatever it missed before reconnecting.
 */
export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const message = body.message?.trim();
  if (!message) {
    return new Response(JSON.stringify({ error: "message is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ADR-0005 + Golden Rule 4: per-project isolation. The previous
  // fallback to `process.cwd()` (the MARVIN repo itself) meant that a
  // client who forgot to send `cwd` would have MARVIN run against its
  // own source tree — a self-modifying agent surface. Reject early.
  // Audit finding #7.
  const rawCwd = body.cwd?.trim();
  const cwdError = validateCwd(rawCwd);
  if (cwdError) {
    return new Response(
      JSON.stringify({ error: cwdError, code: "invalid-cwd" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }
  const cwd = rawCwd as string;

  // ADR-0041 — MARVIN owns the ACTIVE PROJECT's graph lifecycle. Fire-and-
  // forget a refresh of both graphs for this project's workDir (never MARVIN's
  // own repo — `cwd` is the validated project dir). Both builds are AST-only
  // (no LLM cost) and internally debounced (HEAD-change + 10-min interval), so
  // calling per-turn is cheap and usually a no-op. Non-blocking: the turn
  // proceeds immediately; an out-of-date graph just means this turn reads
  // files and the next turn has the fresh graph.
  void maybeRefreshGraphify(cwd, { source: "chat-turn" }).catch(() => {});
  void maybeRefreshKnowledgeGraph(cwd, { source: "chat-turn" }).catch(() => {});

  const projectId = body.projectId?.trim() || slugifyWorkDir(cwd);
  const marvinSessionId = body.marvinSessionId?.trim() || randomUUID();
  const turnId = randomUUID();

  // Concurrency guard: one live turn per `marvinSessionId`. A second
  // POST arriving while a turn is still running — double-submit, a
  // second tab, or a reconnect that POSTed instead of subscribing to
  // `/api/chat/resume` — would otherwise evict the running turn and
  // surface to it as the "replaced by a newer turn on the same session"
  // stream error, silently orphaning a possibly-heavy in-flight turn.
  // Refuse instead: to interrupt, the client must POST `/api/chat/cancel`
  // first; to re-attach, GET `/api/chat/resume`. A fresh session (no
  // `marvinSessionId` sent) generates a random id above and can't
  // collide. Ended turns sitting in their 60s grace window have
  // `ended === true` and never block.
  const inflight = getLiveTurn(marvinSessionId);
  if (inflight && !inflight.ended) {
    return new Response(
      JSON.stringify({
        error: "A turn is already in progress for this session.",
        code: "turn-in-progress",
        turnId: inflight.turnId,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }
  const personality: PersonalityMode = body.personality ?? "marvin";
  const runtimeMode: RuntimeMode = body.runtimeMode ?? "opus";
  const permissionStrategy: PermissionStrategy = body.permissionStrategy ?? "auto";
  const playwrightEnabled: boolean = body.playwrightEnabled ?? false;
  const mode: AgentMode = body.mode ?? "agent";
  const thinkingMode: string = body.thinkingMode ?? "high";
  // Advisor effort intentionally has NO "high" fallback here — undefined
  // means "follow the executor", resolved inside runAgent (ADR-0033).
  const advisorThinkingMode: string | undefined =
    body.advisorThinkingMode?.trim() || undefined;

  // Resolution order for model/advisorModel: explicit body fields win;
  // runtimeMode fills the gap; defaultModel() is the last resort.
  const resolved = await resolveRuntimeMode(runtimeMode);
  const executorModel = body.model?.trim() || resolved.model || defaultModel();
  const advisorModel = body.advisorModel?.trim() || resolved.advisorModel;
  // ADR-0036 (revised): planning runs on the chosen ADVISOR model, execution
  // on the EXECUTOR model — routed by ROLE, never hardcoded. In Plan mode the
  // turn's model is the advisor (when one is configured); Agent/Ask turns use
  // the executor. So with executor=Opus / advisor=Fable, you plan on Fable
  // and execute on Opus exactly as selected.
  const model = mode === "plan" && advisorModel ? advisorModel : executorModel;
  const firstMessage = !body.marvinSessionId;

  const systemPrompt = buildSystemPrompt(personality);
  const projectContext = body.skipProjectContext
    ? ""
    : (
        await buildProjectContext({ workDir: cwd, firstMessage }).catch(() => ({
          text: "",
          breakdown: [],
        }))
      ).text;
  // ADR-0037 — name the skills ACTIVE for this project so the model stops
  // reaching for the (always-loaded) irrelevant ones. Default from the
  // fingerprint; overridable in the Skills pane (.marvin/skills.json).
  let activeSkillsBlock = "";
  try {
    activeSkillsBlock = formatActiveSkillsBlock(cwd);
  } catch {
    /* best-effort; never block a turn on skill enablement */
  }
  const appendSystemPrompt = [systemPrompt, projectContext, activeSkillsBlock]
    .filter(Boolean)
    .join("\n\n");

  // Resolve the SDK resume id BEFORE we append turn.user (and before
  // `runAgentDetached` is dispatched below). Two distinct ids exist:
  //   - `marvinSessionId` (JSONL filename, transcript identity)
  //   - SDK `sessionId`  (Claude Agent SDK's internal session, what
  //     `resume` needs to keep agent context across turns)
  // The native client only tracks `marvinSessionId`. If the client sent
  // an explicit SDK sessionId, honour it; otherwise look up the most
  // recent completed turn's SDK id from this transcript. Without this
  // resolution every turn looks like a fresh conversation to the model.
  // Must be declared before `void runAgentDetached()` — async function
  // bodies execute synchronously up to the first await, and the closure
  // access here would hit TDZ if defined later in the same scope.
  // ADR-0022 §3 follow-up: when the client asks for a fresh SDK
  // session, skip the auto-resume lookup entirely. The visible chat
  // and the marvinSessionId are unchanged — only the *server-side*
  // SDK session restarts, dropping the cache that's driving latency.
  // An explicit body.sessionId still wins (in case the user wants to
  // resume a *different* SDK session for some advanced flow).
  const sdkResumeId = body.resetSdkSession
    ? body.sessionId?.trim() || undefined
    : body.sessionId?.trim() ||
      (body.marvinSessionId
        ? lastSdkSessionId(projectId, marvinSessionId)
        : null) ||
      undefined;

  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.user",
    at: new Date().toISOString(),
    message,
  });

  // Register the live turn. Events get pushed to BOTH the on-disk
  // transcript AND this bus; any number of HTTP subscribers can listen.
  const liveTurn = registerLiveTurn({ turnId, marvinSessionId, projectId });

  const turnStartedPayload = {
    marvinSessionId,
    projectId,
    model,
    advisorModel: advisorModel ?? null,
    runtimeMode,
    personality,
    permissionStrategy,
    playwrightEnabled,
    mode,
    thinkingMode,
    advisorThinkingMode: advisorThinkingMode ?? null,
    sdkSessionFresh: !sdkResumeId,
    turnId,
  };
  emitTurnEvent(liveTurn, "turn.started", turnStartedPayload);
  // SessionTurn union now admits `turn.started` natively (audit
  // finding #27). The previous `as unknown as "turn.user"` cast is
  // gone — the transcript log is type-safe again.
  appendSessionTurn(projectId, marvinSessionId, {
    type: "turn.started",
    at: new Date().toISOString(),
    ...turnStartedPayload,
  });

  // Fire-and-forget: the SDK loop runs to completion regardless of
  // whether this HTTP request is still connected. The orchestration lives
  // in `runDetachedTurn` (shared with self-scheduled wakeups, ADR-0031).
  void runDetachedTurn({
    liveTurn,
    projectId,
    marvinSessionId,
    turnId,
    message,
    cwd,
    model,
    advisorModel,
    permissionStrategy,
    playwrightEnabled,
    mode,
    thinkingMode,
    advisorThinkingMode,
    sessionId: sdkResumeId,
    appendSystemPrompt,
    personality,
    // ADR-0051 — pass the live plan snapshot to the SDK prompt only; `message`
    // (persisted above as turn.user) stays clean.
    planContext: body.planContext,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          /* controller closed — client went away */
        }
      };

      // Echo the turn.started we already emitted so this subscriber sees it.
      send("turn.started", turnStartedPayload);

      const onEvent = (e: { event: string; data: unknown }) => {
        send(e.event, e.data);
        // A terminal event means the turn is done — close the stream
        // on this subscriber. Others may still be listening.
        if (e.event === "turn.completed" || e.event === "turn.error") {
          liveTurn.bus.off("event", onEvent);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      };
      liveTurn.bus.on("event", onEvent);

      // If the HTTP client aborts, we detach the listener BUT DO NOT
      // cancel the turn. Explicit user cancels come through the
      // dedicated /api/chat/cancel route.
      req.signal.addEventListener(
        "abort",
        () => {
          liveTurn.bus.off("event", onEvent);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        },
        { once: true },
      );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Validate that the caller-supplied `cwd` is a real directory the user
 * picked, not a stand-in or — worst case — MARVIN's own install root.
 *
 * Returns an error string for the response body, or `null` when the
 * value is acceptable. The fs probe is sync `existsSync` / `statSync`
 * because the route is already inside an awaited handler and the
 * stat is cheap (a single inode read on a happy path).
 *
 * Doesn't sandbox individual file paths inside `cwd` — that's the job
 * of `checkFsPath` in `@marvin/runtime/fs-sandbox`. This helper is
 * scoped to the project-root question only.
 */
function validateCwd(rawCwd: string | undefined): string | null {
  if (!rawCwd) return "cwd is required — pick a project before chatting";
  if (!isAbsolute(rawCwd)) return "cwd must be an absolute path";
  // Audit 🟠 #9: check the cwd is a registered project. The check
  // implicitly rejects MARVIN's own install root (not in projects.json)
  // AND replaces the existsSync / statSync fallback (the user can
  // only add a project via the picker, which already verified the
  // path exists + is a directory).
  const projectCheck = validateProjectCwd(rawCwd);
  if (!projectCheck.ok) {
    // The picker may have a stale entry pointing at a now-deleted dir;
    // fall back to the existence check so the error message is
    // diagnosable.
    const resolvedCwd = resolve(rawCwd);
    if (!existsSync(resolvedCwd)) return `cwd does not exist: ${resolvedCwd}`;
    return projectCheck.error;
  }
  // Defence in depth: still refuse equality with MARVIN's process root.
  // validateProjectCwd already rejects this (MARVIN's repo isn't a
  // registered project) but a future contributor might add it for some
  // testing reason — keep the explicit check.
  const resolvedCwd = resolve(rawCwd);
  const marvinRoot = resolve(process.cwd());
  if (resolvedCwd === marvinRoot) {
    return "cwd cannot be MARVIN's own install root";
  }
  return null;
}
