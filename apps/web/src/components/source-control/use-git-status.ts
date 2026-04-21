"use client";

/**
 * Git-status poll hook for the Source Control panel.
 *
 * Polls `/api/git/status?cwd=…` at `intervalMs` (default 2 s) when:
 *   - `cwd` is non-null,
 *   - `enabled` prop is `true` (the panel's tab is selected),
 *   - `document.visibilityState === "visible"` — the interval is
 *     stopped while the tab is hidden and resumed when it becomes
 *     visible again (M4 tightening: the M2 version just skipped
 *     fetches but left the interval running).
 *
 * Requests carry `If-None-Match` keyed to the last ETag; the server
 * answers 304 with an empty body when nothing changed, saving the
 * parse + setState + re-render on an idle tree.
 */

import type { StatusResult } from "@marvin/git";
import { useCallback, useEffect, useRef, useState } from "react";

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
  const etagRef = useRef<string | null>(null);
  // Reset the ETag whenever cwd/enabled change so we don't serve a
  // 304-matched response from a previous project.
  const keyRef = useRef<string>("");

  const doFetch = useCallback(
    async (signal: AbortSignal, activeCwd: string) => {
      try {
        const res = await fetch(
          `/api/git/status?cwd=${encodeURIComponent(activeCwd)}`,
          {
            signal,
            cache: "no-store",
            headers: etagRef.current
              ? { "If-None-Match": etagRef.current }
              : {},
          },
        );
        if (signal.aborted || !mountedRef.current) return;
        if (res.status === 304) {
          // No-op; keep the last ready state.
          return;
        }
        if (!res.ok) {
          setState({ phase: "error", message: `status ${res.status}` });
          return;
        }
        const newEtag = res.headers.get("etag");
        if (newEtag) etagRef.current = newEtag;
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
    },
    [],
  );

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
      etagRef.current = null;
      return;
    }

    // Reset ETag on cwd/enabled boundary — see note at keyRef.
    const nextKey = `${cwd}::${enabled ? "on" : "off"}`;
    if (keyRef.current !== nextKey) {
      etagRef.current = null;
      keyRef.current = nextKey;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setState((prev) =>
      prev.phase === "ready" ? prev : { phase: "loading" },
    );

    let intervalId: number | null = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void doFetch(controller.signal, cwd);
    };

    const startPolling = () => {
      if (intervalId !== null) return;
      tick();
      intervalId = window.setInterval(tick, intervalMs);
    };

    const stopPolling = () => {
      if (intervalId === null) return;
      window.clearInterval(intervalId);
      intervalId = null;
    };

    const onVisibilityChange = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (typeof document === "undefined" || document.visibilityState === "visible") {
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stopPolling();
      controller.abort();
    };
  }, [cwd, enabled, intervalMs, doFetch]);

  return {
    state,
    refresh: useCallback(() => {
      if (!cwd || !enabled) return;
      // Clear the ETag so the refresh fetches fresh content even if
      // the porcelain output hasn't changed yet on disk (we want a
      // 200 with the latest state, not a 304 matching the stale
      // ETag from before the mutation).
      etagRef.current = null;
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      void doFetch(controller.signal, cwd);
    }, [cwd, enabled, doFetch]),
  };
}
