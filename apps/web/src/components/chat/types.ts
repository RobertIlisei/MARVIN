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

export type MarvinUiState = "idle" | "thinking" | "tool" | "writing" | "error";
