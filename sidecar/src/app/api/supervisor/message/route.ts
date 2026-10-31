/**
 * The user's conversation with the supervisor (ADR-0127 §2, plan milestone 5).
 *
 * - POST /api/supervisor/message { projectId, text, images?, imageText? } → { id, at }
 *     ADR-0129: `images` is up to 4 base64 PNG/JPEG, validated by their bytes
 *     and stored 0600 under the data dir; text may be empty when one is
 *     present. `imageText` is the app's on-device text recognition of them,
 *     scanned for secrets and then dropped — never stored, never sent on. An
 *     image, like text, is never consent and never a ground.
 *     Records the message and wakes the supervisor with it. It CANNOT grant
 *     consent: telling the supervisor "approve X" here resolves nothing — at
 *     most the supervisor escalates X, and the user consents on the raw act in
 *     the inbox (§5). It is the one request `new_session` accepts: the
 *     supervisor cites this message's id, and one message opens at most one tab.
 * - GET  /api/supervisor/message?projectId=… → { messages } (the last 100, oldest first);
 *     each attachment gains an absolute `path` the app (same machine, same
 *     user) renders from. The stored record carries no path.
 *
 * Token-gated and CSRF-guarded like every supervisor route.
 */

import { containsSecretShape } from "@marvin/runtime/session";
import { appendLedgerEntry, isSafeProjectId } from "@marvin/runtime/supervisor-ledger";
import { ensureSupervisorLoop } from "@marvin/runtime/supervisor-loop";
import {
  addUserMessage,
  attachmentPath,
  listMessages,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_USER_MESSAGE_CHARS,
  parseImages,
} from "@marvin/runtime/supervisor-messages";
import { getSupervisorState, SUPERVISOR_TOKEN_HEADER, verifySupervisorToken } from "@marvin/runtime/supervisor-state";
import { noteSidecarPort } from "@marvin/tools/policy";
import { type NextRequest, NextResponse } from "next/server";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Text and fields, plus four images' base64 (4/3 of their decoded cap). In bytes, not UTF-16 units. */
const MAX_BODY_BYTES = 16 * 1024 + MAX_IMAGES_PER_MESSAGE * Math.ceil((MAX_IMAGE_BYTES * 4) / 3 + 4);
const TOKEN_REFUSAL = { error: "supervisor routes need the per-boot capability token (ADR-0127 §5)" };

export async function GET(req: NextRequest) {
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const projectId = req.nextUrl.searchParams.get("projectId")?.trim() ?? "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const messages = listMessages(projectId, { limit: 100 }).map((m) =>
    m.attachments ? { ...m, attachments: m.attachments.map((a) => ({ ...a, path: attachmentPath(projectId, a) })) } : m,
  );
  return NextResponse.json({ messages }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;
  noteSidecarPort(req.nextUrl.port);
  if (!verifySupervisorToken(req.headers.get(SUPERVISOR_TOKEN_HEADER))) return NextResponse.json(TOKEN_REFUSAL, { status: 403 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let body: { projectId?: unknown; text?: unknown; images?: unknown; imageText?: unknown };
  try {
    body = JSON.parse(raw.toString("utf8")) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!isSafeProjectId(projectId)) return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
  const parsed = parseImages(body.images);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const images = parsed.images;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if ((!text && !images.length) || text.length > MAX_USER_MESSAGE_CHARS) {
    return NextResponse.json({ error: `text must be 1–${MAX_USER_MESSAGE_CHARS} characters, or empty beside an image` }, { status: 400 });
  }
  // It reaches a model and a file on disk; a pasted key should do neither (ADR-0127 §6).
  if (containsSecretShape(text)) return NextResponse.json({ error: "the message carries a secret-shaped string — it was not sent" }, { status: 400 });
  // ADR-0129 — the images' recognised text, from the app; a screenshot of a terminal is the usual way a key leaks.
  const imageText = Array.isArray(body.imageText) ? body.imageText.filter((t): t is string => typeof t === "string").join("\n").slice(0, 64_000) : "";
  if (imageText && containsSecretShape(imageText)) {
    return NextResponse.json({ error: "an attached image appears to show a secret — it was not sent" }, { status: 400 });
  }
  if (getSupervisorState(projectId).mode === "off") return NextResponse.json({ error: "the supervisor is off — start it first" }, { status: 409 });
  const loop = ensureSupervisorLoop();
  const m = addUserMessage(projectId, text, images);
  const bytes = images.reduce((n, i) => n + i.data.length, 0);
  const withImages = images.length ? ` · ${images.length} image${images.length === 1 ? "" : "s"}, ${Math.round(bytes / 1024)} KB` : "";
  appendLedgerEntry(projectId, { kind: "message", verb: "message", tab: null, wakeId: null, reason: "user: wrote to the supervisor", reasonCode: "user-message", argSummary: `message ${m.id}${withImages}` });
  loop.noteUserMessage(projectId, m.id);
  return NextResponse.json({ id: m.id, at: m.at });
}
