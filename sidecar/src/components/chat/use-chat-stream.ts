"use client";

import { useCallback, useRef, useState } from "react";
import { marvinFetch } from "@/lib/csrf";
import type { Block, MarvinUiState, Message, TurnStats } from "./types";

/** Shape of a persisted session transcript entry (from /api/sessions/[id]). */
type StoredTurn =
  | { type: "turn.user"; at: string; message: string }
  | { type: "cli.event"; at: string; event: Record<string, unknown> }
  | {
      type: "turn.completed";
      at: string;
      durationMs: number | null;
      costUsd: number | null;
      tokenUsage: { input_tokens?: number; output_tokens?: number } | null;
      sessionId: string | null;
    }
  | { type: "turn.error"; at: string; error: string }
  | Record<string, unknown>;

interface SessionRecord {
  sessionId: string;
  projectId: string;
  turns: StoredTurn[];
}

/**
 * React hook that drives MARVIN's streaming chat.
 *
 * Speaks to POST /api/chat which returns Server-Sent Events:
 *   - `turn.started`   → we show the user message + empty assistant
 *   - `cli.event`      → Claude CLI NDJSON; we reshape into Message blocks
 *   - `turn.completed` → stats + session id for resume
 *   - `turn.error`     → surface the error; leave assistant message visible
 *
 * Derives a high-level `marvinState` from the stream:
 *   - idle       → no in-flight request
 *   - thinking   → request sent, first assistant chunk not yet seen
 *   - tool       → a tool_use block is currently running
 *   - writing    → assistant is emitting text
 *   - error      → last turn ended in `turn.error`
 */
/** Tool names whose results imply a filesystem mutation in the project's
 *  workDir. When one of these completes, the file tree should refetch.
 *  Bash is included unconditionally — `ls`/`cat`/etc. produce a free
 *  refresh; the alternative (parsing the command for fs verbs) is
 *  fragile and the tree fetch is cheap. */
const FS_MUTATING_TOOL_NAMES = new Set(["Edit", "Write", "NotebookEdit", "Bash"]);

export interface UseChatStreamOptions {
  /** Fired when a tool_result lands for an FS-mutating tool. The page
   *  uses this to bump a counter the FileTree subscribes to, so the user
   *  doesn't have to click refresh after every MARVIN edit. */
  onFsMutation?: () => void;
}

export function useChatStream(options: UseChatStreamOptions = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [marvinState, setMarvinState] = useState<MarvinUiState>("idle");
  const [stats, setStats] = useState<TurnStats | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [marvinSessionId, setMarvinSessionId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef<string | null>(null);
  /** Map tool_use_id → tool name. Populated when the assistant emits a
   *  `tool_use` block; consulted when a `tool_result` lands so we can
   *  decide whether the result implies an FS mutation. Cleared per
   *  entry on lookup to keep the map small over a long session. */
  const toolNamesRef = useRef<Map<string, string>>(new Map());
  /** Latest onFsMutation in a ref so the closure inside applyEvent
   *  doesn't capture a stale callback across renders. */
  const onFsMutationRef = useRef(options.onFsMutation);
  onFsMutationRef.current = options.onFsMutation;
  /**
   * Last user message + send options. Held so the structured `error`
   * block can offer a Retry that reuses the same arguments — closes
   * the stream-end UX gap from audit finding #14.
   */
  const lastSendRef = useRef<{
    text: string;
    cwd: string;
    options: {
      personality?: "marvin" | "neutral";
      runtimeMode?: "opus" | "advisor";
      permissionStrategy?: "auto" | "gated";
      playwrightEnabled?: boolean;
      model?: string | null;
      advisorModel?: string | null;
    };
  } | null>(null);

  const send = useCallback(
    async (
      text: string,
      cwd: string,
      options: {
        personality?: "marvin" | "neutral";
        runtimeMode?: "opus" | "advisor";
        permissionStrategy?: "auto" | "gated";
        playwrightEnabled?: boolean;
        model?: string | null;
        advisorModel?: string | null;
      } = {},
    ) => {
      if (!text.trim()) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      // Snapshot the send args so retry() can replay them without the
      // caller having to re-thread state. See audit finding #14.
      lastSendRef.current = { text, cwd, options };

      const userMessage: Message = {
        id: `u-${Date.now()}`,
        role: "user",
        blocks: [{ type: "text", text }],
        at: new Date().toISOString(),
      };
      const assistantId = `a-${Date.now()}`;
      const assistantMessage: Message = {
        id: assistantId,
        role: "assistant",
        blocks: [],
        at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setMarvinState("thinking");

      let response: Response;
      try {
        response = await marvinFetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            cwd,
            sessionId,
            marvinSessionId,
            ...(options.personality ? { personality: options.personality } : {}),
            ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
            ...(options.permissionStrategy ? { permissionStrategy: options.permissionStrategy } : {}),
            ...(options.playwrightEnabled ? { playwrightEnabled: true } : {}),
            ...(options.model ? { model: options.model } : {}),
            ...(options.advisorModel ? { advisorModel: options.advisorModel } : {}),
          }),
          signal: controller.signal,
        });
      } catch (err) {
        setMarvinState("error");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  blocks: [
                    {
                      type: "error",
                      message: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
                      canRetry: true,
                    },
                  ],
                }
              : m,
          ),
        );
        return;
      }

      if (!response.ok || !response.body) {
        setMarvinState("error");
        const errText = await response.text().catch(() => "");
        // 4xx invalid-cwd (audit fix #7) is non-retryable — the user
        // needs to pick a project. Other 5xx are worth retrying.
        const canRetry = response.status >= 500;
        // 409 turn-in-progress: a turn is already live on this session
        // (a second tab / double-submit). Show a clean message, not the
        // raw JSON, and don't offer Retry — retrying just 409s again
        // until the running turn ends. Cancel-then-send to interrupt.
        let message = `HTTP ${response.status}: ${errText.slice(0, 200) || response.statusText}`;
        if (response.status === 409) {
          try {
            const parsed = JSON.parse(errText) as { error?: string };
            if (parsed?.error) message = parsed.error;
          } catch {
            /* fall back to the raw message above */
          }
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  blocks: [
                    {
                      type: "error",
                      message,
                      canRetry,
                    },
                  ],
                }
              : m,
          ),
        );
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "";

      const applyAssistantBlocks = (
        mutator: (blocks: Block[]) => Block[],
      ) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, blocks: mutator(m.blocks) } : m,
          ),
        );
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line === "") {
              currentEvent = "";
              continue;
            }
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              let data: Record<string, unknown>;
              try {
                data = JSON.parse(payload) as Record<string, unknown>;
              } catch {
                continue;
              }
              handleSseEvent(currentEvent, data, {
                setMarvinSessionId,
                setSessionId,
                setMarvinState,
                setStats,
                applyAssistantBlocks,
                setTurnId: (v) => {
                  turnIdRef.current = v;
                },
                toolNames: toolNamesRef.current,
                onFsMutation: onFsMutationRef.current,
              });
            }
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setMarvinState("error");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    blocks: [
                      ...m.blocks,
                      {
                        type: "error",
                        message: `Stream error: ${err instanceof Error ? err.message : String(err)}`,
                        canRetry: true,
                      },
                    ],
                  }
                : m,
            ),
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        // Stream closed without a terminal event (turn.completed /
        // turn.error) — most commonly the SDK crashed after handshake.
        // Pre-fix this surfaced as a plain text block. Audit #14
        // upgraded it to a structured `error` block with a Retry
        // hook so the user can re-fire the same message + sessionId
        // in one click.
        setMarvinState((prev) => {
          if (prev === "thinking" || prev === "writing" || prev === "tool") {
            setMessages((msgs) =>
              msgs.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      blocks: [
                        ...m.blocks,
                        {
                          type: "error",
                          message:
                            "Stream ended without a result. Check the server logs (auth, SDK crash, or cwd doesn't exist).",
                          canRetry: true,
                        },
                      ],
                    }
                  : m,
              ),
            );
            return "error";
          }
          return prev;
        });
      }
    },
    [sessionId, marvinSessionId],
  );

  const cancel = useCallback(async () => {
    // Audit finding #22: previous behaviour snapped the UI to "idle"
    // synchronously and fired /api/chat/cancel best-effort. The user
    // could send a new message while the server was still tearing
    // down the previous turn, then watch the previous turn's cli.events
    // continue to flow into the new bubble. The fix is a `cancelling`
    // intermediate state so the input stays disabled until the server
    // confirms.
    abortRef.current?.abort();
    abortRef.current = null;
    turnIdRef.current = null;
    const sid = marvinSessionId;
    if (!sid) {
      // Nothing on the server to cancel — straight to idle.
      setMarvinState("idle");
      return;
    }
    setMarvinState("cancelling");
    try {
      await marvinFetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marvinSessionId: sid }),
      });
    } catch {
      /* best-effort — even on network failure the local abort
         already detached us from the SSE stream. */
    } finally {
      setMarvinState("idle");
    }
  }, [marvinSessionId]);

  /**
   * Retry the last message. Used by the structured `error` block —
   * see audit finding #14. Marks the most recent error block as
   * `retried` so the button doesn't reappear if the retry also fails
   * (next failure produces its own block).
   */
  const retry = useCallback(() => {
    const last = lastSendRef.current;
    if (!last) return;
    setMessages((prev) => {
      const next = [...prev];
      // Drop the last assistant message that ended in an unretried
      // error block — the retry creates a fresh assistant bubble.
      const lastIdx = next.length - 1;
      const lastMsg = next[lastIdx];
      if (lastMsg && lastMsg.role === "assistant") {
        const lastBlock = lastMsg.blocks[lastMsg.blocks.length - 1];
        if (
          lastBlock &&
          lastBlock.type === "error" &&
          lastBlock.canRetry &&
          !lastBlock.retried
        ) {
          next.pop();
        }
      }
      return next;
    });
    void send(last.text, last.cwd, last.options);
    // The send body above creates a new assistant message; nothing
    // to do for the marker — the popped error block is gone.
  }, [send]);

  /**
   * Attach to a still-running turn (after page refresh / tab reopen).
   *
   * Flow:
   *   1. Hit `/api/chat/resume?marvinSessionId=…`.
   *   2. If the server replies 204, there's no live turn — return `false`
   *      so the caller can load the transcript from disk.
   *   3. If SSE events start flowing, reuse the same event handler used
   *      by `send()` and target the latest assistant message (creating
   *      one if needed).
   */
  const attachLive = useCallback(
    async (attachId: string): Promise<boolean> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let res: Response;
      try {
        res = await marvinFetch(
          `/api/chat/resume?marvinSessionId=${encodeURIComponent(attachId)}`,
          { signal: controller.signal },
        );
      } catch {
        abortRef.current = null;
        return false;
      }
      if (res.status === 204 || !res.body) {
        abortRef.current = null;
        return false;
      }
      if (!res.ok) {
        abortRef.current = null;
        return false;
      }

      // Guarantee there's an assistant bubble to route blocks into. If
      // the last message is already an assistant one, reuse it; else
      // create a fresh shell.
      let assistantId = "";
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          assistantId = last.id;
          return prev;
        }
        assistantId = `a-resume-${Date.now()}`;
        return [
          ...prev,
          {
            id: assistantId,
            role: "assistant",
            blocks: [],
            at: new Date().toISOString(),
          },
        ];
      });
      setMarvinSessionId(attachId);
      setMarvinState("thinking");

      const applyAssistantBlocks = (mutator: (blocks: Block[]) => Block[]) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, blocks: mutator(m.blocks) } : m,
          ),
        );
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let currentEvent = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line === "") {
              currentEvent = "";
              continue;
            }
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith("data: ")) {
              const payload = line.slice(6);
              let data: Record<string, unknown>;
              try {
                data = JSON.parse(payload) as Record<string, unknown>;
              } catch {
                continue;
              }
              // resume.attached is informational only.
              if (currentEvent === "resume.attached") continue;
              handleSseEvent(currentEvent, data, {
                setMarvinSessionId,
                setSessionId,
                setMarvinState,
                setStats,
                applyAssistantBlocks,
                setTurnId: (v) => {
                  turnIdRef.current = v;
                },
                toolNames: toolNamesRef.current,
                onFsMutation: onFsMutationRef.current,
              });
            }
          }
        }
      } catch {
        // Disconnect mid-stream — user's problem to re-open a tab; we
        // leave the UI in whatever state it's in.
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
      return true;
    },
    [],
  );

  const decideConfirm = useCallback(
    async (
      toolUseId: string,
      decision: "allow" | "deny",
      message?: string,
    ) => {
      const turnId = turnIdRef.current;
      if (!turnId) return;
      try {
        await marvinFetch("/api/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ turnId, toolUseId, decision, message }),
        });
      } catch {
        // Best-effort; if /api/confirm is unreachable the SDK will eventually
        // time out or the abort controller will kill the turn.
      }
      setMessages((prev) =>
        prev.map((m) => ({
          ...m,
          blocks: m.blocks.map((b) =>
            b.type === "tool_use" && b.id === toolUseId && b.pendingConfirm
              ? { ...b, confirmDecision: decision, pendingConfirm: undefined }
              : b,
          ),
        })),
      );
    },
    [],
  );

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    turnIdRef.current = null;
    setMessages([]);
    setMarvinState("idle");
    setStats(null);
    setSessionId(null);
    setMarvinSessionId(null);
  }, []);

  /**
   * Replace the current message list with the result of a stored session
   * transcript (as returned by `GET /api/sessions/[sessionId]`). Re-uses the
   * same `mergeAssistantContent` pipeline as the live stream so tool calls
   * and their results render identically.
   */
  const hydrateFromSession = useCallback((record: SessionRecord) => {
    abortRef.current?.abort();
    abortRef.current = null;
    turnIdRef.current = null;

    const nextMessages: Message[] = [];
    let currentAssistant: Message | null = null;
    let lastCompleted: TurnStats | null = null;
    let lastCliSessionId: string | null = null;

    const ensureAssistant = (at: string): Message => {
      if (!currentAssistant) {
        currentAssistant = {
          id: `a-${nextMessages.length}-${Date.now()}`,
          role: "assistant",
          blocks: [],
          at,
        };
        nextMessages.push(currentAssistant);
      }
      return currentAssistant;
    };

    const closeAssistant = () => {
      currentAssistant = null;
    };

    for (const turn of record.turns) {
      const t = turn as { type?: string };
      if (t.type === "turn.user") {
        const u = turn as { at: string; message: string };
        closeAssistant();
        nextMessages.push({
          id: `u-${nextMessages.length}-${Date.now()}`,
          role: "user",
          blocks: [{ type: "text", text: u.message }],
          at: u.at,
        });
      } else if (t.type === "cli.event") {
        const ev = (turn as { event?: Record<string, unknown> }).event ?? {};
        const msg = (ev as {
          type?: string;
          message?: { content?: Array<Record<string, unknown>> };
        });
        if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
          const assistant = ensureAssistant((turn as { at: string }).at);
          assistant.blocks = mergeAssistantContent(
            assistant.blocks,
            msg.message!.content ?? [],
          );
        } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
          const assistant = ensureAssistant((turn as { at: string }).at);
          for (const b of msg.message!.content!) {
            const r = b as {
              type?: string;
              tool_use_id?: string;
              content?: string;
              is_error?: boolean;
            };
            if (r.type === "tool_result" && r.tool_use_id) {
              assistant.blocks = assistant.blocks.map((block) =>
                block.type === "tool_use" && block.id === r.tool_use_id
                  ? {
                      ...block,
                      result:
                        typeof r.content === "string"
                          ? r.content
                          : JSON.stringify(r.content ?? ""),
                      resultIsError: r.is_error === true,
                      running: false,
                    }
                  : block,
              );
            }
          }
        }
      } else if (t.type === "turn.completed") {
        const c = turn as {
          durationMs: number | null;
          costUsd: number | null;
          tokenUsage: { input_tokens?: number; output_tokens?: number } | null;
          sessionId: string | null;
        };
        lastCompleted = {
          sessionId: c.sessionId,
          durationMs: c.durationMs,
          costUsd: c.costUsd,
          tokens: {
            input: c.tokenUsage?.input_tokens ?? 0,
            output: c.tokenUsage?.output_tokens ?? 0,
          },
        };
        lastCliSessionId = c.sessionId;
        closeAssistant();
      } else if (t.type === "turn.error") {
        const assistant = ensureAssistant((turn as { at: string }).at);
        assistant.blocks = [
          ...assistant.blocks,
          {
            type: "text",
            text: `⚠ ${(turn as { error: string }).error}`,
          },
        ];
        closeAssistant();
      }
    }

    // Any `tool_use` block still marked `running: true` after the full
    // replay is stale: hydration is restoring past state, so by
    // definition nothing is in flight. This happens when a session was
    // interrupted between tool_use and tool_result (crash, ⌘W mid-
    // turn, network drop) — the JSONL transcript captured the spawn
    // but not the return, and replaying it leaves blocks "running"
    // forever.
    //
    // The visible symptom was the scout / advisor companion orbs
    // staying lit across page reloads whenever a Task subagent had
    // ever been spawned. Live state comes from `send` / `attachLive`
    // AFTER hydration, so it's safe to force-close everything here;
    // if a turn is genuinely still in flight on the server, the
    // resume path re-attaches to the SSE stream and re-flips those
    // blocks to `running: true` with live events.
    const closedMessages = nextMessages.map((m) =>
      m.role === "assistant"
        ? {
            ...m,
            blocks: m.blocks.map((b) =>
              b.type === "tool_use" && b.running ? { ...b, running: false } : b,
            ),
          }
        : m,
    );

    setMessages(closedMessages);
    setStats(lastCompleted);
    setSessionId(lastCliSessionId);
    setMarvinSessionId(record.sessionId);
    setMarvinState("idle");
  }, []);

  return {
    messages,
    marvinState,
    stats,
    sessionId,
    marvinSessionId,
    send,
    cancel,
    retry,
    reset,
    decideConfirm,
    hydrateFromSession,
    attachLive,
  };
}

/**
 * Reshape one NDJSON event into assistant blocks + derived UI state.
 *
 * Claude CLI stream-json shape:
 *   { type: "assistant", message: { content: [...] } }
 *   { type: "user",      message: { content: [{ type: "tool_result", ... }] } }
 *   { type: "system",    ... }
 *   { type: "result",    ... }
 */
function handleSseEvent(
  eventName: string,
  data: Record<string, unknown>,
  ctx: {
    setMarvinSessionId: (v: string) => void;
    setSessionId: (v: string) => void;
    setMarvinState: (v: MarvinUiState) => void;
    setStats: (v: TurnStats) => void;
    applyAssistantBlocks: (mutator: (blocks: Block[]) => Block[]) => void;
    setTurnId: (v: string) => void;
    toolNames: Map<string, string>;
    onFsMutation?: () => void;
  },
): void {
  if (eventName === "turn.started") {
    if (typeof data.marvinSessionId === "string") {
      ctx.setMarvinSessionId(data.marvinSessionId);
    }
    if (typeof data.turnId === "string") {
      ctx.setTurnId(data.turnId);
    }
    return;
  }

  if (eventName === "confirm.request") {
    const payload = data as {
      turnId?: string;
      toolUseId?: string;
      toolName?: string;
      input?: unknown;
      reason?: string;
      title?: string;
      description?: string;
      displayName?: string;
    };
    const toolUseId = payload.toolUseId;
    if (!toolUseId || !payload.turnId) return;
    ctx.setTurnId(payload.turnId);
    ctx.applyAssistantBlocks((prev) => {
      const exists = prev.some(
        (b) => b.type === "tool_use" && b.id === toolUseId,
      );
      if (exists) {
        return prev.map((b) =>
          b.type === "tool_use" && b.id === toolUseId
            ? {
                ...b,
                pendingConfirm: {
                  turnId: payload.turnId!,
                  toolUseId,
                  reason: payload.reason ?? "",
                  ...(payload.title ? { title: payload.title } : {}),
                  ...(payload.description
                    ? { description: payload.description }
                    : {}),
                  ...(payload.displayName
                    ? { displayName: payload.displayName }
                    : {}),
                },
              }
            : b,
        );
      }
      return [
        ...prev,
        {
          type: "tool_use",
          id: toolUseId,
          name: payload.toolName ?? "unknown",
          input: payload.input,
          running: false,
          pendingConfirm: {
            turnId: payload.turnId!,
            toolUseId,
            reason: payload.reason ?? "",
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.description
              ? { description: payload.description }
              : {}),
            ...(payload.displayName
              ? { displayName: payload.displayName }
              : {}),
          },
        },
      ];
    });
    ctx.setMarvinState("tool");
    return;
  }

  if (eventName === "turn.completed") {
    if (typeof data.sessionId === "string") ctx.setSessionId(data.sessionId);
    const usage = (data.tokenUsage ?? {}) as {
      input_tokens?: number;
      output_tokens?: number;
    };
    ctx.setStats({
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      durationMs:
        typeof data.durationMs === "number" ? data.durationMs : null,
      costUsd: typeof data.costUsd === "number" ? data.costUsd : null,
      tokens: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
    });
    ctx.setMarvinState("idle");
    return;
  }

  if (eventName === "turn.error") {
    ctx.setMarvinState("error");
    const msg = typeof data.error === "string" ? data.error : "unknown error";
    ctx.applyAssistantBlocks((blocks) => [
      ...blocks,
      { type: "text", text: `⚠ ${msg}` },
    ]);
    return;
  }

  if (eventName !== "cli.event") return;

  const ev = (data.event ?? data) as {
    type?: string;
    message?: {
      content?: Array<Record<string, unknown>>;
    };
  };

  if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    // Register tool_use_id → tool name so the matching tool_result can
    // be classified later for FS-mutation purposes.
    for (const b of ev.message!.content ?? []) {
      const block = b as { type?: string; id?: string; name?: string };
      if (block.type === "tool_use" && block.id && block.name) {
        ctx.toolNames.set(block.id, block.name);
      }
    }
    ctx.applyAssistantBlocks((prev) =>
      mergeAssistantContent(prev, ev.message!.content ?? []),
    );
    const hasToolUse = (ev.message!.content ?? []).some(
      (b) => (b as { type?: string }).type === "tool_use",
    );
    ctx.setMarvinState(hasToolUse ? "tool" : "writing");
    return;
  }

  if (ev.type === "user" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message!.content!) {
      if ((b as { type?: string }).type === "tool_result") {
        const toolUseId = (b as { tool_use_id?: string }).tool_use_id;
        const content = (b as { content?: string }).content ?? "";
        const isError = (b as { is_error?: boolean }).is_error === true;
        if (toolUseId) {
          // Look up the tool name registered when its tool_use block
          // arrived. If it's an FS-mutating tool, signal the file tree
          // to refetch. Successful AND failed calls trigger refresh —
          // a failed Bash command may still have left side effects.
          const toolName = ctx.toolNames.get(toolUseId);
          if (toolName && FS_MUTATING_TOOL_NAMES.has(toolName)) {
            ctx.onFsMutation?.();
          }
          ctx.toolNames.delete(toolUseId);
          ctx.applyAssistantBlocks((prev) =>
            prev.map((block) =>
              block.type === "tool_use" && block.id === toolUseId
                ? {
                    ...block,
                    result: typeof content === "string" ? content : JSON.stringify(content),
                    resultIsError: isError,
                    running: false,
                  }
                : block,
            ),
          );
        }
      }
    }
    ctx.setMarvinState("writing");
    return;
  }
}

function mergeAssistantContent(
  prev: Block[],
  raw: Array<Record<string, unknown>>,
): Block[] {
  const next: Block[] = [...prev];
  for (const b of raw) {
    const type = (b as { type?: string }).type;
    if (type === "text") {
      const text = ((b as { text?: string }).text ?? "").toString();
      if (!text) continue;
      // Fold consecutive text blocks into one bubble.
      const last = next[next.length - 1];
      if (last && last.type === "text") {
        next[next.length - 1] = { type: "text", text: last.text + text };
      } else {
        next.push({ type: "text", text });
      }
    } else if (type === "tool_use") {
      const id = (b as { id?: string }).id;
      if (id && next.some((x) => x.type === "tool_use" && x.id === id)) {
        continue; // dedupe streaming restarts
      }
      next.push({
        type: "tool_use",
        id,
        name: (b as { name?: string }).name ?? "unknown",
        input: (b as { input?: unknown }).input,
        running: true,
      });
    }
  }
  return next;
}
