"use client";

import { useCallback, useRef, useState } from "react";
import type { Block, MarvinUiState, Message, TurnStats } from "./types";

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
export function useChatStream() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [marvinState, setMarvinState] = useState<MarvinUiState>("idle");
  const [stats, setStats] = useState<TurnStats | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [marvinSessionId, setMarvinSessionId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const turnIdRef = useRef<string | null>(null);

  const send = useCallback(
    async (text: string, cwd: string) => {
      if (!text.trim()) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

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
        response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text,
            cwd,
            sessionId,
            marvinSessionId,
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
                      type: "text",
                      text: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
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
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  blocks: [
                    {
                      type: "text",
                      text: `HTTP ${response.status}: ${errText.slice(0, 200) || response.statusText}`,
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
                        type: "text",
                        text: `Stream error: ${err instanceof Error ? err.message : String(err)}`,
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
      }
    },
    [sessionId, marvinSessionId],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    turnIdRef.current = null;
    setMarvinState("idle");
  }, []);

  const decideConfirm = useCallback(
    async (
      toolUseId: string,
      decision: "allow" | "deny",
      message?: string,
    ) => {
      const turnId = turnIdRef.current;
      if (!turnId) return;
      try {
        await fetch("/api/confirm", {
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

  return {
    messages,
    marvinState,
    stats,
    sessionId,
    marvinSessionId,
    send,
    cancel,
    reset,
    decideConfirm,
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
