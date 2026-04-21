"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Git-status poll hook for the Source Control panel.
 *
 * Polls `/api/git/status?cwd=…` at `intervalMs` (default 2 s) when:
 *   - `cwd` is non-null,
 *   - `enabled` prop is `true` (the panel is visible; parent toggles
 *     this on tab change),
 *   - `document.visibilityState === "visible"` (no polling while
 *     the window is hidden — M4 tightens this further).
 *
 * Requests carry an `AbortSignal` so overlapping polls get cancelled
 * cleanly on cwd / enabled change. Errors are surfaced but don't stop
 * the poll — a transient 502 shouldn't freeze the UI.
 */

import type { StatusResult } from "@marvin/git";

export type GitStatusState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; data: GitStatusOk }
  | { phase: "no-repo" }
  | { phase: "error"; message: string };

export interface GitStatusOk extends StatusResult {
  enabled: true;
}

interface UseGitStatusArgs {
  cwd: string | null;
  enabled: boolean;
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 2000;

export function useGitStatus({
  cwd,
  enabled,
  intervalMs = DEFAULT_INTERVAL_MS,
}: UseGitStatusArgs): {
  state: GitStatusState;
  refresh: () => void;
} {
  const [state, setState] = useState<GitStatusState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const tickRef = useRef(0);

  // Kick one fetch right now; used by both the poll and manual `refresh`.
  const fetchOnce = useRef(async (signal: AbortSignal, activeCwd: string) => {
    try {
      const res = await fetch(
        `/api/git/status?cwd=${encodeURIComponent(activeCwd)}`,
        { signal, cache: "no-store" },
      );
      if (signal.aborted || !mountedRef.current) return;
      if (!res.ok) {
        setState({ phase: "error", message: `status ${res.status}` });
        return;
      }
      const body = await res.json();
      if (signal.aborted || !mountedRef.current) return;
      if (body?.enabled === false) {
        setState({ phase: "no-repo" });
        return;
      }
      if (body?.enabled === true && body?.branch && Array.isArray(body?.files)) {
        setState({ phase: "ready", data: body as GitStatusOk });
        return;
      }
      setState({ phase: "error", message: "unexpected-shape" });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      if (!mountedRef.current) return;
      setState({ phase: "error", message: String((e as Error)?.message ?? e) });
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    if (!cwd || !enabled) {
      setState({ phase: "idle" });
      return;
    }

    let cancelled = false;
    const tick = ++tickRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ phase: "loading" });

    const run = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      // Stale guard — if cwd/enabled changed during the fetch, drop
      // the result on the floor.
      await fetchOnce.current(controller.signal, cwd);
      if (cancelled || tick !== tickRef.current) return;
    };

    void run();
    const interval = window.setInterval(() => {
      void run();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      controller.abort();
    };
  }, [cwd, enabled, intervalMs]);

  return {
    state,
    refresh: () => {
      if (!cwd || !enabled) return;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      void fetchOnce.current(controller.signal, cwd);
    },
  };
}
