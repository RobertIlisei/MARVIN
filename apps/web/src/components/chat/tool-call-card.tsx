"use client";

import { useState } from "react";
import type { Block } from "./types";

type ToolBlock = Extract<Block, { type: "tool_use" }>;

function toolDescriptor(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return String(o.command ?? "").slice(0, 200);
    case "Read":
    case "Edit":
    case "Write": {
      const p = String(o.file_path ?? o.path ?? "");
      return p;
    }
    case "Grep":
      return `pattern: ${String(o.pattern ?? "")}`;
    case "Glob":
      return String(o.pattern ?? "");
    case "WebFetch":
    case "WebSearch":
      return String(o.url ?? o.query ?? "");
    case "Task":
      return String(o.description ?? "subagent");
    default:
      return Object.keys(o).length > 0 ? JSON.stringify(o).slice(0, 160) : "";
  }
}

const ICONS: Record<string, string> = {
  Bash: "›_",
  Read: "◎",
  Edit: "✎",
  Write: "+",
  Grep: "⌕",
  Glob: "⊙",
  WebFetch: "↯",
  WebSearch: "⌕",
  Task: "▶",
};

export function ToolCallCard({ block }: { block: ToolBlock }) {
  const [expanded, setExpanded] = useState(false);
  const descriptor = toolDescriptor(block.name, block.input);
  const icon = ICONS[block.name] ?? "⊗";

  const statusColor = block.resultIsError
    ? "text-[color:var(--color-danger)]"
    : block.running
      ? "text-[color:var(--color-accent)]"
      : "text-[color:var(--color-success)]";

  const statusLabel = block.resultIsError
    ? "failed"
    : block.running
      ? "running…"
      : "done";

  return (
    <div className="rise-in group my-1.5 rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-white/[0.02]"
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[color:var(--color-border)] font-mono text-[color:var(--color-accent)]">
          {icon}
        </span>
        <span className="font-mono text-[color:var(--color-fg)]">{block.name}</span>
        {descriptor && (
          <span className="truncate text-[color:var(--color-fg-dim)] font-mono">
            {descriptor}
          </span>
        )}
        <span className={`ml-auto shrink-0 font-mono text-[10px] uppercase tracking-widest ${statusColor}`}>
          {statusLabel}
          {block.running && (
            <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle" />
          )}
        </span>
        <span className="shrink-0 text-[color:var(--color-fg-faint)] opacity-0 group-hover:opacity-100">
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-[color:var(--color-border)] px-3 py-2 font-mono text-[11px]">
          <div className="text-[color:var(--color-fg-dim)]">input</div>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[color:var(--color-fg)]/80">
            {typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input, null, 2)}
          </pre>
          {block.result !== undefined && (
            <>
              <div className="mt-3 text-[color:var(--color-fg-dim)]">
                output
                {block.resultIsError && (
                  <span className="ml-2 text-[color:var(--color-danger)]">error</span>
                )}
              </div>
              <pre
                className={`mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words ${block.resultIsError ? "text-[color:var(--color-danger)]/90" : "text-[color:var(--color-fg)]/80"}`}
              >
                {block.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
