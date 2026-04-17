"use client";

import type { Message } from "./types";
import { ToolCallCard } from "./tool-call-card";

/**
 * Render a text block with minimal markdown (fenced code + inline code + paragraphs).
 * Deliberately small — we avoid pulling markdown-it / react-markdown for v1.
 */
function RenderText({ text }: { text: string }) {
  // Split by fenced code blocks while preserving order.
  const parts: Array<
    | { kind: "code"; lang: string; body: string }
    | { kind: "text"; body: string }
  > = [];
  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ kind: "text", body: text.slice(last, m.index) });
    }
    parts.push({ kind: "code", lang: m[1] ?? "", body: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    parts.push({ kind: "text", body: text.slice(last) });
  }

  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        p.kind === "code" ? (
          <pre
            key={i}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/80 p-3 font-mono text-[12px] leading-relaxed text-[color:var(--color-fg)]/90 overflow-x-auto scroll-thin"
          >
            {p.lang && (
              <div className="mb-1 text-[10px] uppercase tracking-widest text-[color:var(--color-fg-dim)]">
                {p.lang}
              </div>
            )}
            <code>{p.body}</code>
          </pre>
        ) : (
          <div key={i} className="whitespace-pre-wrap text-[color:var(--color-fg)]/95 text-sm leading-relaxed">
            {renderInline(p.body)}
          </div>
        ),
      )}
    </div>
  );
}

function renderInline(body: string): React.ReactNode {
  // Split on backtick spans; render as inline code.
  const out: React.ReactNode[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index));
    out.push(
      <code
        key={i++}
        className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/60 px-1 py-[1px] font-mono text-[12px] text-[color:var(--color-accent)]"
      >
        {m[1]}
      </code>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return <>{out}</>;
}

export function MessageView({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div
      className={`rise-in flex ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[90%] rounded-2xl px-4 py-3 ${
          isUser
            ? "glass border-[color:var(--color-accent-deep)]/30 bg-[color:var(--color-accent-glow)]"
            : "glass"
        }`}
      >
        <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-[color:var(--color-fg-dim)]">
          <span>{isUser ? "you" : "marvin"}</span>
        </div>
        <div className="space-y-1.5">
          {message.blocks.map((b, i) =>
            b.type === "text" ? (
              <RenderText key={i} text={b.text} />
            ) : (
              <ToolCallCard key={b.id ?? i} block={b} />
            ),
          )}
          {message.blocks.length === 0 && !isUser && (
            <div className="flex items-center gap-2 text-[color:var(--color-fg-dim)] text-sm">
              <span className="inline-block h-1 w-1 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
              <span>thinking…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
