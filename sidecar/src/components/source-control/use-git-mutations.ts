"use client";

/**
 * Client-side wrapper for `/api/git/*` mutation routes.
 *
 * Every mutation follows the same 1-or-3-step dance:
 *
 *   1. POST the op to its route.
 *   2. 409 with `needsConfirm` → show a modal. Accept → POST to
 *      `/api/git/confirm`, get a token, POST the original request
 *      again with `X-Marvin-Confirmed: <token>`.
 *   3. 200 → success; the caller refreshes the panel.
 *
 * The confirm-modal state is surfaced here so the panel can render
 * a single `<ConfirmGitOpDialog>` for all mutation types.
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import type { GitOp, GitWriteSeverity } from "@marvin/git";
import { useCallback, useRef, useState } from "react";
import { marvinFetch } from "@/lib/csrf";

export type RemoteErrorCode =
  | "auth-publickey"
  | "auth-failed"
  | "network"
  | "non-fast-forward"
  | "no-upstream"
  | "no-remote"
  | "merge-conflict"
  | "dirty-working-tree"
  | "detached-head"
  | "git-failed";

export interface MutationError {
  kind:
    | "network"
    | "policy-deny"
    | "invalid"
    | "upstream"
    | "nothing-to-commit"
    | "branch-exists"
    | "branch-not-found"
    | "remote";
  message: string;
  /** Raw body from the server — useful for debugging. */
  detail?: unknown;
  /**
   * Populated only for `kind: "remote"`. The classifier lives in
   * `sidecar/src/lib/git-remote-errors.ts` and drives the
   * specialised `RemoteErrorBanner`.
   */
  remote?: {
    code: RemoteErrorCode;
    remedy: string;
    stderr: string | null;
  };
}

export interface PendingConfirm {
  /** The op the server said needed confirming. */
  op: GitOp;
  severity: GitWriteSeverity;
  reason: string;
  /** Short human-readable action label, e.g. "Discard working-tree changes". */
  title: string;
  /**
   * Called when the user accepts the confirm; the hook completes the
   * token round-trip + retry under the hood.
   */
  accept(): Promise<void>;
  reject(): void;
}

export interface GitMutationsState {
  pending: PendingConfirm | null;
  /** Most recent error; cleared on the next successful call. */
  error: MutationError | null;
  /** `true` while any mutation (or its retry) is in flight. */
  busy: boolean;
}

interface UseGitMutationsArgs {
  cwd: string | null;
  /** Called after every successful mutation so the panel can re-poll. */
  onChanged?(): void;
}

export function useGitMutations({ cwd, onChanged }: UseGitMutationsArgs) {
  const [state, setState] = useState<GitMutationsState>({
    pending: null,
    error: null,
    busy: false,
  });
  // Keep a mounted flag so late promise resolutions don't setState
  // after unmount (React 19 warns louder than React 18 did).
  const mountedRef = useRef(true);
  const patch = useCallback((p: Partial<GitMutationsState>) => {
    if (!mountedRef.current) return;
    setState((prev) => ({ ...prev, ...p }));
  }, []);

  const dispatch = useCallback(
    async (
      route: string,
      body: Record<string, unknown>,
      opForToken: (serverOp: GitOp) => GitOp,
      actionTitle: string,
    ): Promise<boolean> => {
      if (!cwd) {
        patch({
          error: {
            kind: "invalid",
            message: "no project selected",
          },
        });
        return false;
      }
      patch({ busy: true, error: null });

      const doPost = async (token?: string): Promise<Response> => {
        return marvinFetch(`/api/git/${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { "X-Marvin-Confirmed": token } : {}),
          },
          body: JSON.stringify({ ...body, cwd }),
        });
      };

      try {
        let res = await doPost();

        if (res.status === 409) {
          const peek = await res.clone().json().catch(() => ({}));
          if (peek?.error === "needs-confirm") {
            const accepted = await askConfirm({
              op: peek.op as GitOp,
              severity: peek.severity ?? "warn",
              reason: peek.reason ?? "",
              title: actionTitle,
              setState,
              mountedRef,
            });
            if (!accepted) {
              patch({ busy: false });
              return false;
            }
            const finalOp = opForToken(peek.op as GitOp);
            const tokenRes = await marvinFetch("/api/git/confirm", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ op: finalOp, cwd }),
            });
            if (!tokenRes.ok) {
              const tb = await tokenRes.json().catch(() => ({}));
              patch({
                busy: false,
                error: {
                  kind: "upstream",
                  message: tb?.error ?? "failed to mint token",
                  detail: tb,
                },
              });
              return false;
            }
            const { token } = await tokenRes.json();
            res = await doPost(token);
          }
        }

        if (res.ok) {
          patch({ busy: false });
          onChanged?.();
          return true;
        }

        const errBody = await res.json().catch(() => ({}));
        const remoteCode = parseRemoteErrorCode(errBody?.error);
        if (remoteCode) {
          patch({
            busy: false,
            error: {
              kind: "remote",
              message: errBody?.remedy ?? errBody?.error ?? `status ${res.status}`,
              detail: errBody,
              remote: {
                code: remoteCode,
                remedy: errBody?.remedy ?? "",
                stderr: typeof errBody?.stderr === "string" ? errBody.stderr : null,
              },
            },
          });
          return false;
        }
        const errKind = classifyError(res.status, errBody?.error);
        patch({
          busy: false,
          error: {
            kind: errKind,
            message: errBody?.reason ?? errBody?.error ?? `status ${res.status}`,
            detail: errBody,
          },
        });
        return false;
      } catch (e) {
        patch({
          busy: false,
          error: {
            kind: "network",
            message: (e as Error)?.message ?? "network error",
          },
        });
        return false;
      }
    },
    [cwd, onChanged, patch],
  );

  // Each of these wraps `dispatch` with the right route + body shape.
  // The `opForToken` closure rebuilds the op the server is about to
  // execute — passing back `peek.op` verbatim is fine because the
  // server-side structural equality check is identity-like, but we
  // do the round-trip explicitly so future nuance (e.g., the server
  // re-detects `hasPushedHead` at exec time) has a place to sit.
  const stage = useCallback(
    (paths: string[]) =>
      dispatch("stage", { paths }, (op) => op, `Stage ${paths.length} file${paths.length === 1 ? "" : "s"}`),
    [dispatch],
  );
  const unstage = useCallback(
    (paths: string[]) =>
      dispatch("unstage", { paths }, (op) => op, `Unstage ${paths.length} file${paths.length === 1 ? "" : "s"}`),
    [dispatch],
  );
  const discard = useCallback(
    (paths: string[], mode: "working" | "staged") =>
      dispatch(
        "discard",
        { paths, mode },
        (op) => op,
        mode === "working"
          ? `Discard working-tree changes to ${paths.length} file${paths.length === 1 ? "" : "s"}`
          : `Unstage ${paths.length} file${paths.length === 1 ? "" : "s"}`,
      ),
    [dispatch],
  );
  const commit = useCallback(
    (message: string, amend: boolean) =>
      dispatch(
        "commit",
        { message, amend },
        (op) => op,
        amend ? "Amend previous commit" : "Create commit",
      ),
    [dispatch],
  );
  const branchCreate = useCallback(
    (name: string, from?: string) =>
      dispatch(
        "branch/create",
        from ? { name, from } : { name },
        (op) => op,
        `Create branch \`${name}\``,
      ),
    [dispatch],
  );
  const branchSwitch = useCallback(
    (name: string) =>
      dispatch(
        "branch/switch",
        { name },
        (op) => op,
        `Switch to branch \`${name}\``,
      ),
    [dispatch],
  );
  const branchDelete = useCallback(
    (name: string, force?: boolean) =>
      dispatch(
        "branch/delete",
        force ? { name, force: true } : { name },
        (op) => op,
        `Delete branch \`${name}\``,
      ),
    [dispatch],
  );

  // Renamed to `gitFetch` so the identifier doesn't shadow the
  // built-in `fetch()` used inside `dispatch` above.
  const gitFetch = useCallback(
    (remote?: string) =>
      dispatch(
        "fetch",
        remote ? { remote } : {},
        (op) => op,
        `Fetch from ${remote ?? "origin"}`,
      ),
    [dispatch],
  );
  const pull = useCallback(
    (strategy: "ff-only" | "rebase" | "merge") =>
      dispatch(
        "pull",
        { strategy },
        (op) => op,
        strategy === "ff-only"
          ? "Pull (fast-forward)"
          : strategy === "rebase"
            ? "Pull with rebase"
            : "Pull with merge",
      ),
    [dispatch],
  );
  const push = useCallback(
    (forceWithLease: boolean) =>
      dispatch(
        "push",
        forceWithLease ? { forceWithLease: true } : {},
        (op) => op,
        forceWithLease ? "Push (force-with-lease)" : "Push",
      ),
    [dispatch],
  );

  const dismissError = useCallback(() => patch({ error: null }), [patch]);

  return {
    state,
    stage,
    unstage,
    discard,
    commit,
    branchCreate,
    branchSwitch,
    branchDelete,
    fetch: gitFetch,
    pull,
    push,
    dismissError,
    unmount: useCallback(() => {
      mountedRef.current = false;
    }, []),
  };
}

function parseRemoteErrorCode(code: unknown): RemoteErrorCode | null {
  if (typeof code !== "string") return null;
  const known: readonly RemoteErrorCode[] = [
    "auth-publickey",
    "auth-failed",
    "network",
    "non-fast-forward",
    "no-upstream",
    "no-remote",
    "merge-conflict",
    "dirty-working-tree",
    "detached-head",
    "git-failed",
  ];
  return (known as readonly string[]).includes(code)
    ? (code as RemoteErrorCode)
    : null;
}

/**
 * Presents the confirm modal by parking a `PendingConfirm` in state,
 * then resolves once the user accepts or rejects.
 */
function askConfirm(args: {
  op: GitOp;
  severity: GitWriteSeverity;
  reason: string;
  title: string;
  setState: React.Dispatch<React.SetStateAction<GitMutationsState>>;
  mountedRef: React.RefObject<boolean>;
}): Promise<boolean> {
  const { op, severity, reason, title, setState, mountedRef } = args;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      if (mountedRef.current) {
        setState((prev) => ({ ...prev, pending: null }));
      }
      resolve(accepted);
    };
    setState((prev) => ({
      ...prev,
      pending: {
        op,
        severity,
        reason,
        title,
        accept: async () => done(true),
        reject: () => done(false),
      },
    }));
  });
}

function classifyError(status: number, code: unknown): MutationError["kind"] {
  if (status === 403) return "policy-deny";
  if (status === 400) return "invalid";
  if (code === "nothing-to-commit") return "nothing-to-commit";
  if (code === "branch-exists") return "branch-exists";
  if (code === "branch-not-found") return "branch-not-found";
  return "upstream";
}
