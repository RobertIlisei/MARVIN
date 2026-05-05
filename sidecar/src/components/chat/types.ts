/**
 * UI-level chat domain types, derived from the Claude CLI NDJSON stream.
 * The raw events land as `cli.event` SSE events; this layer reshapes them
 * into something we can render.
 */

export type Role = "user" | "assistant" | "system";

export type Block =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id?: string;
      name: string;
      input: unknown;
      /** Result of the tool (after tool_result arrives), if any. */
      result?: string;
      resultIsError?: boolean;
      /** Truthy while the CLI is executing; false once we see tool_result. */
      running?: boolean;
      /** Pending confirm gate — rendered as an inline allow/deny card. */
      pendingConfirm?: {
        turnId: string;
        toolUseId: string;
        reason: string;
        title?: string;
        description?: string;
        displayName?: string;
      };
      /** User's decision, once made. */
      confirmDecision?: "allow" | "deny";
    }
  | {
      /**
       * Structured error block — the audit (#14) flagged that the
       * previous "stream ended without a result" surface was a plain
       * text block with no recovery path. The error block carries a
       * machine-readable kind + an optional retry hint so MessageView
       * can render a Retry button. The hook owns the actual retry
       * logic; the block just signals "you can try this again."
       */
      type: "error";
      message: string;
      /** When true, MessageView renders a Retry button. */
      canRetry: boolean;
      /** Already-retried marker so we don't show the button twice. */
      retried?: boolean;
    };

export interface Message {
  id: string;
  role: Role;
  blocks: Block[];
  /** Rough timestamp for sorting + display. */
  at: string;
}

export interface TurnStats {
  sessionId: string | null;
  durationMs: number | null;
  costUsd: number | null;
  tokens: {
    input: number;
    output: number;
  };
}

export type MarvinUiState =
  | "idle"
  | "thinking"
  | "tool"
  | "writing"
  | "cancelling"
  | "error";
