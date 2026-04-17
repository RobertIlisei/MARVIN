"use client";

import "@xterm/xterm/css/xterm.css";

import { useEffect, useRef, useState } from "react";

import type { Terminal as Xterm } from "@xterm/xterm";
import type { FitAddon as FitAddonT } from "@xterm/addon-fit";

const PROMPT = "\x1b[38;5;39m❯\x1b[0m ";
const HISTORY_KEY = "marvin.term.history";
const HISTORY_MAX = 100;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function saveHistory(h: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HISTORY_MAX)));
  } catch {
    /* no storage */
  }
}

export function Terminal({ cwd }: { cwd: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddonT | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);

  // Line buffer + history state kept in refs to avoid re-mounting xterm.
  const lineRef = useRef("");
  const histRef = useRef<string[]>([]);
  const histIdxRef = useRef<number>(-1);

  const [running, setRunning] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Mount xterm once. Effect runs after the container is in the DOM.
  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    async function mount() {
      const [{ Terminal: XtermCtor }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !containerRef.current) return;

      const term = new XtermCtor({
        fontFamily:
          'var(--font-mono), ui-monospace, SFMono-Regular, "Menlo", monospace',
        fontSize: 12,
        lineHeight: 1.35,
        cursorBlink: true,
        cursorStyle: "bar",
        allowProposedApi: true,
        convertEol: true,
        scrollback: 5000,
        theme: {
          background: "rgba(0,0,0,0)",
          foreground: "#e8e8ef",
          cursor: "#7fd3ff",
          cursorAccent: "#07070a",
          selectionBackground: "rgba(127, 211, 255, 0.28)",
          black: "#1a1a20",
          red: "#ff7a7a",
          green: "#6be4a6",
          yellow: "#ffd27a",
          blue: "#7fd3ff",
          magenta: "#c38bff",
          cyan: "#7fd3ff",
          white: "#e8e8ef",
          brightBlack: "#585866",
          brightRed: "#ff9a9a",
          brightGreen: "#8bedba",
          brightYellow: "#ffde9a",
          brightBlue: "#9adfff",
          brightMagenta: "#d4a6ff",
          brightCyan: "#9adfff",
          brightWhite: "#ffffff",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      try {
        fit.fit();
      } catch {
        /* container not measured yet */
      }

      histRef.current = loadHistory();
      histIdxRef.current = histRef.current.length;

      term.writeln(
        "\x1b[2mmarvin terminal — zsh -c in your project dir. Ctrl+C to cancel.\x1b[0m",
      );
      term.write(PROMPT);

      term.onKey(({ key, domEvent }) => {
        const ev = domEvent;
        // Ctrl+C — cancel a running command, else clear the line.
        if (ev.ctrlKey && (ev.key === "c" || ev.key === "C")) {
          if (busyRef.current) {
            controllerRef.current?.abort();
            return;
          }
          term.write("^C\r\n");
          lineRef.current = "";
          term.write(PROMPT);
          return;
        }
        // Ctrl+L — clear screen.
        if (ev.ctrlKey && (ev.key === "l" || ev.key === "L")) {
          term.clear();
          term.write(PROMPT + lineRef.current);
          return;
        }
        if (busyRef.current) return;
        if (ev.key === "Enter") {
          const cmd = lineRef.current;
          term.write("\r\n");
          lineRef.current = "";
          if (cmd.trim()) {
            histRef.current.push(cmd);
            saveHistory(histRef.current);
            histIdxRef.current = histRef.current.length;
            void runCommand(cmd);
          } else {
            term.write(PROMPT);
          }
          return;
        }
        if (ev.key === "Backspace") {
          if (lineRef.current.length > 0) {
            lineRef.current = lineRef.current.slice(0, -1);
            term.write("\b \b");
          }
          return;
        }
        if (ev.key === "ArrowUp") {
          if (histRef.current.length === 0) return;
          histIdxRef.current = Math.max(0, histIdxRef.current - 1);
          const prev = histRef.current[histIdxRef.current] ?? "";
          // Clear current line
          for (let i = 0; i < lineRef.current.length; i++) term.write("\b \b");
          lineRef.current = prev;
          term.write(prev);
          return;
        }
        if (ev.key === "ArrowDown") {
          if (histRef.current.length === 0) return;
          histIdxRef.current = Math.min(
            histRef.current.length,
            histIdxRef.current + 1,
          );
          const next =
            histIdxRef.current >= histRef.current.length
              ? ""
              : (histRef.current[histIdxRef.current] ?? "");
          for (let i = 0; i < lineRef.current.length; i++) term.write("\b \b");
          lineRef.current = next;
          term.write(next);
          return;
        }
        // Printable character
        if (key && key.length === 1 && key.charCodeAt(0) >= 32) {
          lineRef.current += key;
          term.write(key);
          return;
        }
      });

      async function runCommand(cmd: string) {
        busyRef.current = true;
        setRunning(true);
        const controller = new AbortController();
        controllerRef.current = controller;
        try {
          const res = await fetch("/api/terminal/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd, cmd }),
            signal: controller.signal,
          });
          if (!res.ok || !res.body) {
            term.writeln(
              `\x1b[31m[terminal] HTTP ${res.status}: ${res.statusText}\x1b[0m`,
            );
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            // Parse SSE frames: blank-line separated, each frame has
            // `event: x` and `data: {...}` lines.
            let idx;
            while ((idx = buf.indexOf("\n\n")) !== -1) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              let evName = "message";
              let dataLine = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) evName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
              }
              if (!dataLine) continue;
              let parsed: unknown;
              try {
                parsed = JSON.parse(dataLine);
              } catch {
                continue;
              }
              if (evName === "stdout" || evName === "stderr") {
                const payload = parsed as { data: string };
                if (evName === "stderr") term.write(`\x1b[31m${payload.data}\x1b[0m`);
                else term.write(payload.data);
              } else if (evName === "exit") {
                const payload = parsed as {
                  code: number | null;
                  signal: string | null;
                  durationMs: number;
                };
                if (payload.code !== 0) {
                  term.writeln(
                    `\x1b[2m[exit ${payload.code ?? payload.signal ?? "?"} · ${(payload.durationMs / 1000).toFixed(2)}s]\x1b[0m`,
                  );
                } else {
                  term.writeln(
                    `\x1b[2m[ok · ${(payload.durationMs / 1000).toFixed(2)}s]\x1b[0m`,
                  );
                }
              }
            }
          }
        } catch (e) {
          if ((e as { name?: string }).name !== "AbortError") {
            term.writeln(
              `\x1b[31m[terminal] ${e instanceof Error ? e.message : String(e)}\x1b[0m`,
            );
          } else {
            term.writeln("\x1b[2m[canceled]\x1b[0m");
          }
        } finally {
          busyRef.current = false;
          setRunning(false);
          controllerRef.current = null;
          term.write(PROMPT);
        }
      }

      termRef.current = term;
      fitRef.current = fit;

      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
        } catch {
          /* not yet measured */
        }
      });
      resizeObserver.observe(containerRef.current);
      setMounted(true);
    }

    void mount();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [cwd]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-[11px] text-[color:var(--color-fg-dim)]">
        <span className="text-[color:var(--color-fg-faint)]">terminal</span>
        <span className="truncate text-[color:var(--color-fg)]/70">
          {cwd || "—"}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[10px] text-[color:var(--color-fg-faint)]">
          {running ? (
            <>
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[color:var(--color-accent)]" />
              running · ctrl-c to stop
            </>
          ) : (
            <>ready</>
          )}
        </span>
      </div>
      <div
        ref={containerRef}
        className="scroll-thin min-h-0 flex-1 overflow-hidden bg-[color:var(--color-bg)]/60 px-2 py-1"
      />
      {!mounted && (
        <div className="absolute px-4 py-2 text-xs text-[color:var(--color-fg-faint)]">
          mounting terminal…
        </div>
      )}
    </div>
  );
}
