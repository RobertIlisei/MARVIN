"use client";

/**
 * Client-side wrappers around `/api/files/write/*` that handle:
 *
 *   - JSON POST body shaping per route
 *   - The `X-Marvin-Confirmed` token round-trip when the server returns
 *     `409 needs-confirm`
 *   - Typed error surfaces the caller can switch on (collisions, stale,
 *     exists, policy-deny)
 *   - Revalidation callback after success
 *
 * The confirm-flow contract: when a mutation returns `409 needs-confirm`,
 * the hook calls the consumer-provided `onConfirm(reason, severity)`.
 * If that returns `true`, the hook calls `/confirm` to mint a token and
 * replays the original request with `X-Marvin-Confirmed: <token>`. The
 * caller sees only the final outcome — success or an error with
 * structured detail.
 */

import { useCallback } from "react";
import { marvinFetch } from "@/lib/csrf";

type Severity = "warn" | "danger";

export interface FsMutationConfirmRequest {
  reason: string;
  severity: Severity;
  /** Plain-English summary of the op, for the modal body. */
  summary: string;
}

export interface UseFsMutationsOptions {
  /** Absolute project root. */
  cwd: string;
  /** Called to ask the user to confirm a destructive op. Return true to proceed. */
  onConfirm(req: FsMutationConfirmRequest): Promise<boolean> | boolean;
  /** Called after any successful mutation so the tree can re-fetch. */
  onRevalidate(): void;
  /** Optional: called on recoverable errors for toast surfaces. */
  onError?(err: FsMutationError): void;
}

export type FsMutationError =
  | { kind: "exists"; path: string }
  | { kind: "stale"; currentMtime: number; size: number }
  | { kind: "collisions"; collisions: string[] }
  | { kind: "policy-deny"; reason: string }
  | { kind: "sandbox"; error: string }
  | { kind: "io-error"; detail: string }
  | { kind: "cancelled" }
  | { kind: "unknown"; status: number; body: unknown };

type FsWriteOp =
  | { kind: "create-file"; path: string; bytes: number }
  | { kind: "create-dir"; path: string }
  | { kind: "write-file"; path: string; bytes: number; overwrite: boolean }
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; from: string[]; to: string }
  | { kind: "delete-trash"; paths: string[] }
  | { kind: "delete-permanent"; paths: string[] };

export type FsMutationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: FsMutationError };

export interface UseFsMutations {
  createFile(
    path: string,
    content?: string,
    overwrite?: boolean,
  ): Promise<FsMutationResult<{ path: string }>>;
  createDir(path: string): Promise<FsMutationResult<{ path: string }>>;
  save(
    path: string,
    content: string,
    expectedMtime?: number,
  ): Promise<FsMutationResult<{ path: string; mtime: number; size: number }>>;
  rename(
    from: string,
    to: string,
  ): Promise<FsMutationResult<{ from: string; to: string }>>;
  move(
    from: string[],
    to: string,
  ): Promise<FsMutationResult<{ moved: Array<{ from: string; to: string }> }>>;
  del(
    paths: string[],
    mode: "trash" | "permanent",
  ): Promise<FsMutationResult<{ deleted: string[] }>>;
}

/**
 * Build a fetch helper that encapsulates the confirm-token round-trip.
 * Kept outside the hook body so callers don't accidentally re-create the
 * handlers on every render — the hook memoises via `useCallback`.
 */
async function postWithConfirm(params: {
  cwd: string;
  path: string;
  op: FsWriteOp;
  body: Record<string, unknown>;
  opts: UseFsMutationsOptions;
  summary: string;
}): Promise<{ res: Response; body: unknown }> {
  const doPost = (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers["X-Marvin-Confirmed"] = token;
    return marvinFetch(params.path, {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
    });
  };

  let res = await doPost(null);
  if (res.status !== 409) {
    return { res, body: await safeJson(res) };
  }
  const body409 = (await safeJson(res)) as {
    error?: string;
    reason?: string;
    severity?: Severity;
  };
  if (body409.error !== "needs-confirm") {
    return { res, body: body409 };
  }

  const approved = await params.opts.onConfirm({
    reason: body409.reason ?? "confirmation required",
    severity: body409.severity ?? "warn",
    summary: params.summary,
  });
  if (!approved) {
    return { res, body: { error: "cancelled" } };
  }

  const mintRes = await marvinFetch("/api/files/write/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: params.cwd, op: params.op }),
  });
  const mintBody = (await safeJson(mintRes)) as {
    token?: string;
    needsConfirm?: boolean;
  };
  if (!mintRes.ok || !mintBody.token) {
    return { res: mintRes, body: mintBody };
  }
  res = await doPost(mintBody.token);
  return { res, body: await safeJson(res) };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function mapError(
  status: number,
  body: unknown,
): FsMutationError {
  const b = body as
    | {
        error?: string;
        reason?: string;
        currentMtime?: number;
        size?: number;
        collisions?: string[];
        detail?: string;
      }
    | null;
  const code = b?.error ?? "";
  if (code === "cancelled") return { kind: "cancelled" };
  if (code === "exists") return { kind: "exists", path: "" };
  if (code === "stale")
    return {
      kind: "stale",
      currentMtime: b?.currentMtime ?? 0,
      size: b?.size ?? 0,
    };
  if (code === "collisions")
    return { kind: "collisions", collisions: b?.collisions ?? [] };
  if (code === "policy-deny")
    return { kind: "policy-deny", reason: b?.reason ?? "denied" };
  if (code === "io-error")
    return { kind: "io-error", detail: b?.detail ?? "io failed" };
  if (
    code === "path-escapes-cwd" ||
    code === "symlink-rejected" ||
    code === "symlink-escapes-cwd" ||
    code === "path-contains-null" ||
    code === "path-too-long" ||
    code === "is-directory" ||
    code === "not-a-directory" ||
    code === "not-found" ||
    code === "parent-not-found"
  ) {
    return { kind: "sandbox", error: code };
  }
  return { kind: "unknown", status, body };
}

export function useFsMutations(opts: UseFsMutationsOptions): UseFsMutations {
  const after = useCallback(
    <T>(res: Response, body: unknown): FsMutationResult<T> => {
      if (res.ok) {
        opts.onRevalidate();
        return { ok: true, data: body as T };
      }
      const err = mapError(res.status, body);
      opts.onError?.(err);
      return { ok: false, error: err };
    },
    [opts],
  );

  const createFile = useCallback<UseFsMutations["createFile"]>(
    async (path, content = "", overwrite = false) => {
      const bytes = new TextEncoder().encode(content).length;
      const op: FsWriteOp = { kind: "create-file", path, bytes };
      const { res, body } = await postWithConfirm({
        cwd: opts.cwd,
        path: "/api/files/write/create",
        op,
        body: { cwd: opts.cwd, path, kind: "file", content, overwrite },
        opts,
        summary: `create file ${path}`,
      });
      return after<{ path: string }>(res, body);
    },
    [opts, after],
  );

  const createDir = useCallback<UseFsMutations["createDir"]>(
    async (path) => {
      const op: FsWriteOp = { kind: "create-dir", path };
      const { res, body } = await postWithConfirm({
        cwd: opts.cwd,
        path: "/api/files/write/create",
        op,
        body: { cwd: opts.cwd, path, kind: "dir" },
        opts,
        summary: `create folder ${path}`,
      });
      return after<{ path: string }>(res, body);
    },
    [opts, after],
  );

  const save = useCallback<UseFsMutations["save"]>(
    async (path, content, expectedMtime) => {
      const bytes = new TextEncoder().encode(content).length;
      const op: FsWriteOp = {
        kind: "write-file",
        path,
        bytes,
        overwrite: true,
      };
      const { res, body } = await postWithConfirm({
        cwd: opts.cwd,
        path: "/api/files/write/save",
        op,
        body: { cwd: opts.cwd, path, content, expectedMtime },
        opts,
        summary: `save ${path}`,
      });
      return after<{ path: string; mtime: number; size: number }>(res, body);
    },
    [opts, after],
  );

  const rename = useCallback<UseFsMutations["rename"]>(
    async (from, to) => {
      const op: FsWriteOp = { kind: "rename", from, to };
      const { res, body } = await postWithConfirm({
        cwd: opts.cwd,
        path: "/api/files/write/rename",
        op,
        body: { cwd: opts.cwd, from, to },
        opts,
        summary: `rename ${from} → ${to}`,
      });
      return after<{ from: string; to: string }>(res, body);
    },
    [opts, after],
  );

  const move = useCallback<UseFsMutations["move"]>(
    async (from, to) => {
      const op: FsWriteOp = { kind: "move", from, to };
      const { res, body } = await postWithConfirm({
        cwd: opts.cwd,
        path: "/api/files/write/move",
        op,
        body: { cwd: opts.cwd, from, to },
        opts,
        summary: `move ${from.length} item(s) → ${to}`,
      });
      return after<{ moved: Array<{ from: string; to: string }> }>(res, body);
    },
    [opts, after],
  );

  const del = useCallback<UseFsMutations["del"]>(
    async (paths, mode) => {
      const op: FsWriteOp =
        mode === "trash"
          ? { kind: "delete-trash", paths }
          : { kind: "delete-permanent", paths };
      const { res, body } = await postWithConfirm({
        cwd: opts.cwd,
        path: "/api/files/write/delete",
        op,
        body: { cwd: opts.cwd, paths, mode },
        opts,
        summary:
          mode === "trash"
            ? `move ${paths.length} item(s) to Trash`
            : `permanently delete ${paths.length} item(s)`,
      });
      return after<{ deleted: string[] }>(res, body);
    },
    [opts, after],
  );

  return { createFile, createDir, save, rename, move, del };
}
