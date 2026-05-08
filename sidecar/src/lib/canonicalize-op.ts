/**
 * Canonicalise an `FsWriteOp` so `/api/files/write/confirm` stores
 * exactly the same op that mutation routes reconstruct.
 *
 * The mutation routes (`/create`, `/save`, `/rename`, `/move`, `/delete`)
 * run each path field through `checkFsPath` and use the returned
 * `absolutePath`. `/confirm`, without this helper, would store the
 * client-sent string verbatim — leading to `token/op mismatch` when the
 * client sent a non-canonical form (e.g. double slashes, trailing
 * slashes, or a relative path).
 *
 * Used only by `/confirm` — the mutation routes already canonicalise
 * inline.
 */

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import type { FsWriteOp } from "@marvin/tools/fs-write-policy";

export type CanonicalizeResult =
  | { ok: true; op: FsWriteOp }
  | { ok: false; field: string; error: string };

async function canon(
  cwd: string,
  target: string,
  mustExist: boolean,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const result = await checkFsPath({
    cwd,
    target,
    mustExist,
    allowDirectory: true,
  });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, path: result.absolutePath };
}

export async function canonicalizeOp(
  op: FsWriteOp,
  absCwd: string,
): Promise<CanonicalizeResult> {
  switch (op.kind) {
    case "create-file":
    case "create-dir": {
      const c = await canon(absCwd, op.path, false);
      if (!c.ok) return { ok: false, field: "path", error: c.error };
      return op.kind === "create-file"
        ? { ok: true, op: { ...op, path: c.path } }
        : { ok: true, op: { ...op, path: c.path } };
    }
    case "write-file": {
      const c = await canon(absCwd, op.path, true);
      if (!c.ok) return { ok: false, field: "path", error: c.error };
      return { ok: true, op: { ...op, path: c.path } };
    }
    case "rename": {
      const f = await canon(absCwd, op.from, true);
      if (!f.ok) return { ok: false, field: "from", error: f.error };
      const t = await canon(absCwd, op.to, false);
      if (!t.ok) return { ok: false, field: "to", error: t.error };
      return { ok: true, op: { kind: "rename", from: f.path, to: t.path } };
    }
    case "move": {
      const from: string[] = [];
      for (const src of op.from) {
        const c = await canon(absCwd, src, true);
        if (!c.ok) return { ok: false, field: `from[${src}]`, error: c.error };
        from.push(c.path);
      }
      const t = await canon(absCwd, op.to, true);
      if (!t.ok) return { ok: false, field: "to", error: t.error };
      return { ok: true, op: { kind: "move", from, to: t.path } };
    }
    case "delete-trash":
    case "delete-permanent": {
      const paths: string[] = [];
      for (const p of op.paths) {
        const c = await canon(absCwd, p, true);
        if (!c.ok) return { ok: false, field: `paths[${p}]`, error: c.error };
        paths.push(c.path);
      }
      return op.kind === "delete-trash"
        ? { ok: true, op: { kind: "delete-trash", paths } }
        : { ok: true, op: { kind: "delete-permanent", paths } };
    }
  }
}
