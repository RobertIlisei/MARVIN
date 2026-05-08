/**
 * POST /api/files/write/upload
 *
 * Multipart file upload from the OS (typically via drag-and-drop onto the
 * file tree). Receives one or more `file` parts + a `cwd` + `destDir`
 * field, validates each destination path through `checkFsPath` +
 * `fsWritePolicy`, and writes the accepted files. Over-cap files are
 * skipped (not errored) so a partial batch still delivers useful files.
 *
 * **CSRF** — multipart POSTs are a "simple" request in CORS terms and
 * bypass preflight. A malicious cross-origin page could trigger one
 * directly. To force preflight we require a custom `X-Marvin-Client: 1`
 * header; fetching that header triggers a preflight OPTIONS which we
 * never answer with `Access-Control-Allow-Headers`. This turns the
 * route into a preflight-gated resource effectively same-origin-only.
 * See [ADR-0009](../../../../../../../docs/decisions/0009-file-uploads-from-os.md).
 *
 * Caps:
 *   - 50 files per batch
 *   - 10 MB per file
 *   - 50 MB total batch size
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type FsWriteOp, fsWritePolicy } from "@marvin/tools/fs-write-policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_FILE_MAX = 10 * 1024 * 1024; // 10 MB
const BATCH_MAX = 50 * 1024 * 1024; // 50 MB
const COUNT_MAX = 50;

interface UploadedEntry {
  name: string;
  path: string;
  bytes: number;
}

interface SkippedEntry {
  name: string;
  reason: string;
}

export async function POST(req: NextRequest) {
  // CSRF hardening. ADR-0009 first established this pattern for the
  // multipart upload; the shared helper in `@/lib/csrf` now applies it
  // uniformly across every mutating route, so the legacy inline check
  // that used to live here is redundant and was removed.
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "invalid multipart body" },
      { status: 400 },
    );
  }

  const cwd = form.get("cwd");
  const destDir = form.get("destDir");
  if (typeof cwd !== "string" || typeof destDir !== "string") {
    return NextResponse.json(
      { error: "cwd and destDir required (as form fields)" },
      { status: 400 },
    );
  }

  const cwdCheck = await checkFsPath({
    cwd,
    target: cwd,
    mustExist: true,
    allowDirectory: true,
  });
  if (!cwdCheck.ok) {
    return NextResponse.json({ error: cwdCheck.error }, { status: 400 });
  }
  const absCwd = cwdCheck.absolutePath;

  const destCheck = await checkFsPath({
    cwd: absCwd,
    target: destDir,
    mustExist: true,
    allowDirectory: true,
  });
  if (!destCheck.ok || !destCheck.isDirectory) {
    return NextResponse.json(
      { error: `destDir: ${destCheck.ok ? "not a directory" : destCheck.error}` },
      { status: 400 },
    );
  }
  const absDest = destCheck.absolutePath;

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: "no files provided" }, { status: 400 });
  }
  if (files.length > COUNT_MAX) {
    return NextResponse.json(
      { error: `too many files (cap ${COUNT_MAX})` },
      { status: 413 },
    );
  }

  const uploaded: UploadedEntry[] = [];
  const skipped: SkippedEntry[] = [];
  let batchBytes = 0;

  for (const file of files) {
    if (file.size > PER_FILE_MAX) {
      skipped.push({
        name: file.name,
        reason: `exceeds per-file cap (${PER_FILE_MAX} bytes)`,
      });
      continue;
    }
    if (batchBytes + file.size > BATCH_MAX) {
      skipped.push({
        name: file.name,
        reason: `batch total exceeds ${BATCH_MAX} bytes`,
      });
      continue;
    }
    // Basename only — paths from drag-and-drop that contain slashes are
    // a red flag (Finder normalises them to flat lists; a nested name
    // indicates the uploader is trying something).
    const baseName = path.basename(file.name);
    if (!baseName || baseName.startsWith(".") && baseName.includes("/")) {
      skipped.push({ name: file.name, reason: "invalid filename" });
      continue;
    }
    const targetPath = path.join(absDest, baseName);
    const pathCheck = await checkFsPath({
      cwd: absCwd,
      target: targetPath,
      mustExist: false,
      allowDirectory: false,
    });
    if (!pathCheck.ok) {
      skipped.push({ name: baseName, reason: pathCheck.error });
      continue;
    }
    const op: FsWriteOp = {
      kind: "create-file",
      path: pathCheck.absolutePath,
      bytes: file.size,
    };
    const decision = fsWritePolicy(op, absCwd);
    if (decision.class === "deny") {
      skipped.push({ name: baseName, reason: `policy-deny: ${decision.reason}` });
      continue;
    }
    if (decision.class === "confirm") {
      // Uploads deliberately don't support per-file confirm — the user
      // has already authorised the drop gesture. We skip secret-file
      // uploads instead of silently writing them.
      skipped.push({
        name: baseName,
        reason: `requires explicit confirm: ${decision.reason}`,
      });
      continue;
    }
    try {
      // `wx` flag refuses to overwrite — uploader can rename and retry
      // if they really want to replace.
      const buf = Buffer.from(await file.arrayBuffer());
      await fs.writeFile(pathCheck.absolutePath, buf, { flag: "wx" });
      uploaded.push({
        name: baseName,
        path: pathCheck.absolutePath,
        bytes: file.size,
      });
      batchBytes += file.size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException | null)?.code;
      if (code === "EEXIST") {
        skipped.push({ name: baseName, reason: "file already exists" });
      } else {
        skipped.push({ name: baseName, reason: `io-error: ${String(e)}` });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    uploaded,
    skipped,
    destDir: absDest,
  });
}
