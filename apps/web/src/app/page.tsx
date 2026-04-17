"use client";

import { useEffect, useRef, useState } from "react";

import { MarvinBrain } from "@/components/brain/marvin-brain";
import { MessageView } from "@/components/chat/message-view";
import { useChatStream } from "@/components/chat/use-chat-stream";
import { ChatInput } from "@/components/input/chat-input";
import { StatusBar } from "@/components/shell/status-bar";

const CWD_KEY = "marvin.cwd";

export default function Home() {
  const {
    messages,
    marvinState,
    stats,
    marvinSessionId,
    send,
    cancel,
    reset,
  } = useChatStream();

  const [cwd, setCwd] = useState<string>("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(CWD_KEY);
      if (saved) setCwd(saved);
    } catch {
      /* no storage */
    }
  }, []);

  useEffect(() => {
    try {
      if (cwd) localStorage.setItem(CWD_KEY, cwd);
    } catch {
      /* no storage */
    }
  }, [cwd]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const isEmpty = messages.length === 0;
  const busy = marvinState !== "idle" && marvinState !== "error";

  return (
    <main className="flex h-screen w-screen overflow-hidden">
      {/* LEFT — chat column */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-2xl font-semibold tracking-tight text-[color:var(--color-accent)]">
              MARVIN
            </span>
            <span className="text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
              Moderately Advanced Robotic Virtual Intelligence Network
            </span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <button
              type="button"
              onClick={reset}
              disabled={isEmpty}
              className="rounded-md border border-[color:var(--color-border)] px-2.5 py-1 text-[11px] font-mono text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-30"
            >
              new session
            </button>
          </div>
        </header>

        {/* Status bar */}
        <div className="px-6">
          <StatusBar
            state={marvinState}
            stats={stats}
            marvinSessionId={marvinSessionId}
          />
        </div>

        {/* Conversation */}
        <div
          ref={scrollerRef}
          className="scroll-thin flex-1 overflow-y-auto px-6 py-6"
        >
          {isEmpty ? (
            <EmptyState cwd={cwd} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {messages.map((m) => (
                <MessageView key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>

        {/* Input dock */}
        <div className="mx-auto w-full max-w-3xl px-6 pb-6">
          <ChatInput
            cwd={cwd}
            onCwdChange={setCwd}
            onSend={(text) => send(text, cwd)}
            onCancel={cancel}
            busy={busy}
            disabled={!cwd.trim()}
          />
        </div>
      </section>

      {/* RIGHT — MARVIN brain + meta */}
      <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col border-l border-[color:var(--color-border)] bg-gradient-to-b from-transparent via-[color:var(--color-bg-elev)]/30 to-transparent px-6 py-8 md:flex">
        <div className="flex flex-col items-center gap-4">
          <MarvinBrain state={marvinState} size={300} />
          <div className="text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
              state
            </div>
            <div className="mt-1 font-mono text-sm text-[color:var(--color-accent)]">
              {labelFor(marvinState)}
            </div>
          </div>
        </div>

        <div className="mt-auto space-y-3 font-mono text-[11px] text-[color:var(--color-fg-dim)]">
          <div>
            <span className="text-[color:var(--color-fg-faint)]">project</span>
            <div className="mt-1 truncate text-[color:var(--color-fg)]/85">
              {cwd || "—"}
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-[color:var(--color-border)] pt-3">
            <span className="text-[color:var(--color-fg-faint)]">model</span>
            <span className="text-[color:var(--color-fg)]/85">claude-opus-4-7</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[color:var(--color-fg-faint)]">v</span>
            <span className="text-[color:var(--color-fg)]/85">0.0.1 · phase 2</span>
          </div>
        </div>
      </aside>
    </main>
  );
}

function labelFor(state: string): string {
  return (
    {
      idle: "standing by",
      thinking: "thinking",
      tool: "running a tool",
      writing: "writing",
      error: "something broke",
    }[state] ?? state
  );
}

function EmptyState({ cwd }: { cwd: string }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 pt-12 text-center">
      <div className="font-mono text-xs uppercase tracking-[0.4em] text-[color:var(--color-fg-faint)]">
        what are we building?
      </div>
      <h1 className="text-3xl font-semibold leading-snug text-[color:var(--color-fg)]">
        Point me at a project and{" "}
        <span className="text-[color:var(--color-accent)]">tell me what you want</span>.
        <br />
        <span className="text-[color:var(--color-fg-dim)] text-2xl">
          I&apos;ll ask the questions, check the code, and propose a plan before
          I write a single line.
        </span>
      </h1>

      <div className="flex flex-col gap-2 pt-2 text-left text-sm text-[color:var(--color-fg-dim)]">
        <div className="flex gap-3">
          <span className="font-mono text-[color:var(--color-accent)]">1.</span>
          <span>
            Set a <strong className="text-[color:var(--color-fg)]">project directory</strong> below
            {cwd ? "" : " (required)"}.
          </span>
        </div>
        <div className="flex gap-3">
          <span className="font-mono text-[color:var(--color-accent)]">2.</span>
          <span>
            Tell me what to build. E.g.{" "}
            <em className="text-[color:var(--color-fg)]">
              &ldquo;add admin-dashboard auth separate from the business dashboard,
              multi-tenant&rdquo;
            </em>
            .
          </span>
        </div>
        <div className="flex gap-3">
          <span className="font-mono text-[color:var(--color-accent)]">3.</span>
          <span>
            I move through{" "}
            <strong className="text-[color:var(--color-fg)]">
              intake → discovery → impact analysis → architecture → plan → implement → verify → ship
            </strong>
            , surfacing the blast radius before touching anything.
          </span>
        </div>
      </div>

      <blockquote className="glass mt-4 max-w-xl rounded-2xl px-5 py-4 text-left text-sm italic text-[color:var(--color-fg)]/80">
        &ldquo;Here I am, brain the size of a planet, and they ask me to build
        a login page. Fine. Reading your codebase…&rdquo;
        <div className="mt-2 text-right text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
          — MARVIN
        </div>
      </blockquote>
    </div>
  );
}
