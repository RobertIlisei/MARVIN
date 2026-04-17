"use client";

import { useEffect, useRef, useState } from "react";

import { MarvinBrain } from "@/components/brain/marvin-brain";
import { MessageView } from "@/components/chat/message-view";
import { useChatStream } from "@/components/chat/use-chat-stream";
import { FileTree } from "@/components/file-tree/file-tree";
import { FileViewer } from "@/components/file-viewer/file-viewer";
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
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);

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

  // Drive the ambient backdrop from MARVIN's current state.
  useEffect(() => {
    document.body.setAttribute("data-marvin", marvinState);
    return () => {
      document.body.setAttribute("data-marvin", "idle");
    };
  }, [marvinState]);

  const isEmpty = messages.length === 0;
  const busy = marvinState !== "idle" && marvinState !== "error";

  if (isEmpty) {
    return (
      <main className="flex h-screen w-screen flex-col overflow-hidden">
        {/* Header (minimal) */}
        <header className="flex items-center gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-sm font-medium tracking-[0.18em] text-[color:var(--color-fg-dim)]">
              M · A · R · V · I · N
            </span>
          </div>
          <div className="ml-auto font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
            v0.0.1 · phase 2
          </div>
        </header>

        {/* Hero centerpiece */}
        <div className="scroll-thin flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto px-6 py-4">
          <div className="hero-brain-intro flex flex-col items-center gap-3">
            <MarvinBrain state={marvinState} size={360} />
            <div className="flex flex-col items-center gap-1.5 text-center">
              <h1 className="title-glow font-mono text-3xl font-semibold tracking-tight text-[color:var(--color-accent)] md:text-4xl">
                MARVIN
              </h1>
              <p className="max-w-md text-xs text-[color:var(--color-fg-dim)] md:text-sm">
                Moderately Advanced Robotic Virtual Intelligence Network.
                <br />
                <span className="text-[color:var(--color-fg-faint)]">
                  Point me at a project, tell me what you want. I&apos;ll ask,
                  check the code, propose a plan, then write it.
                </span>
              </p>
            </div>
          </div>

          <blockquote className="glass max-w-xl rounded-2xl px-5 py-3 text-center text-xs italic text-[color:var(--color-fg)]/80 md:text-sm">
            &ldquo;Here I am, brain the size of a planet, and they ask me to
            build a login page. Fine. Reading your codebase…&rdquo;
            <div className="mt-1.5 text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
              — MARVIN
            </div>
          </blockquote>
        </div>

        {/* Input dock — pinned to bottom */}
        <div className="mx-auto w-full max-w-2xl px-6 pb-8">
          <ChatInput
            cwd={cwd}
            onCwdChange={setCwd}
            onSend={(text) => send(text, cwd)}
            onCancel={cancel}
            busy={busy}
            disabled={!cwd.trim()}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="flex h-screen w-screen overflow-hidden">
      {/* LEFT — file tree */}
      <aside className="hidden w-[240px] shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/30 lg:flex">
        <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
          <span>files</span>
        </div>
        <div className="min-h-0 flex-1">
          <FileTree
            cwd={cwd}
            onSelect={setSelectedPath}
            {...(selectedPath ? { selectedPath } : {})}
          />
        </div>
      </aside>

      {/* CENTER — chat column */}
      <section className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex items-center gap-4 px-6 py-4">
          <div className="flex items-baseline gap-3">
            <span className="title-glow font-mono text-2xl font-semibold tracking-tight text-[color:var(--color-accent)]">
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

        {/* Conversation (shrinks when a file viewer is open) */}
        <div
          ref={scrollerRef}
          className={`scroll-thin min-h-0 overflow-y-auto px-6 py-6 ${selectedPath ? "flex-[3]" : "flex-1"}`}
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {messages.map((m) => (
              <MessageView key={m.id} message={m} />
            ))}
          </div>
        </div>

        {/* File viewer — splits the center column when a file is selected */}
        {selectedPath && cwd && (
          <div className="flex min-h-0 flex-[2] flex-col">
            <FileViewer
              cwd={cwd}
              filePath={selectedPath}
              onClose={() => setSelectedPath(undefined)}
            />
          </div>
        )}

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

