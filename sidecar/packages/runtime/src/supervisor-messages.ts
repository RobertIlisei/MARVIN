/**
 * The user's conversation with the supervisor (ADR-0127 §2, plan milestone 5;
 * ADR-0128 — the Supervisor tab, milestone 7).
 *
 * `POST /api/supervisor/message` appends the user's message and wakes the
 * supervisor; its `reply` verb appends the answer. The conversation **grants
 * nothing**: "approve X" here produces at most an escalation, and consent is
 * given only on the raw act in the inbox (§5). A user message is the one
 * request `new_session` accepts — one message, one tab.
 *
 * A reply records the wake that wrote it and, as `origin`, the messages that
 * wake carried — assigned by the runtime, never by the model. A user message
 * no reply names is unanswered, and the loop re-enqueues it on resume and at
 * boot (ADR-0128 §6: no user message is ever dropped).
 *
 * Append-only JSONL beside the ledger, 0600, under the data dir.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import { ensureSupervisorDir, supervisorDir } from "./supervisor-ledger";
import { announceProjectEvent } from "./turn-registry";

export const MAX_USER_MESSAGE_CHARS = 4_000;

// ── Images (ADR-0129) ────────────────────────────────────────────────────────
// The user's own input, like their text: stored 0600 under the data dir, sent
// to the model as image content, and never consent, never a ground — an image
// holds no quotable words (`resolveGround`'s `message:` case quotes the text).

export const MAX_IMAGES_PER_MESSAGE = 4;
/** Decoded; base64 of this stays under the API's 5 MB per image. */
export const MAX_IMAGE_BYTES = 3_750_000;
/** Images one wake attaches; the packet names any it leaves out. */
export const MAX_IMAGES_PER_WAKE = 8;
/** Attachment files survive while one of the last this-many messages names them (GET shows 100). */
export const KEEP_ATTACHMENTS_FOR_LAST = 100;

/** What the client re-encodes to. The extension is derived from this map, never from input. */
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg" } as const;
export type ImageMediaType = keyof typeof IMAGE_EXT;
const isImageType = (t: unknown): t is ImageMediaType => typeof t === "string" && Object.hasOwn(IMAGE_EXT, t);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface MessageAttachment {
  id: string;
  mediaType: ImageMediaType;
  bytes: number;
}

export interface ImageInput {
  mediaType: ImageMediaType;
  data: Buffer;
}

/** The declared type, when the bytes are that type. */
function sniff(b: Buffer): ImageMediaType | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/** The route's `images` field: at most 4 PNG/JPEG, each ≤ 3.75 MB decoded, bytes matching the declared type. */
export function parseImages(v: unknown): { ok: true; images: ImageInput[] } | { ok: false; status: 400 | 413; error: string } {
  if (v === undefined || v === null) return { ok: true, images: [] };
  if (!Array.isArray(v)) return { ok: false, status: 400, error: "images must be an array" };
  if (v.length > MAX_IMAGES_PER_MESSAGE) return { ok: false, status: 400, error: `at most ${MAX_IMAGES_PER_MESSAGE} images per message` };
  const images: ImageInput[] = [];
  for (const [i, raw] of v.entries()) {
    const r = (raw && typeof raw === "object" ? raw : {}) as { mediaType?: unknown; data?: unknown };
    if (!isImageType(r.mediaType)) return { ok: false, status: 400, error: `image ${i + 1}: only PNG and JPEG are accepted` };
    if (typeof r.data !== "string" || r.data.length % 4 !== 0 || !BASE64_RE.test(r.data)) return { ok: false, status: 400, error: `image ${i + 1}: not base64` };
    if ((r.data.length / 4) * 3 > MAX_IMAGE_BYTES + 3) return { ok: false, status: 413, error: `image ${i + 1}: larger than ${MAX_IMAGE_BYTES} bytes` };
    const data = Buffer.from(r.data, "base64");
    if (data.length > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: `image ${i + 1}: larger than ${MAX_IMAGE_BYTES} bytes` };
    if (sniff(data) !== r.mediaType) return { ok: false, status: 400, error: `image ${i + 1}: the bytes are not ${r.mediaType}` };
    images.push({ mediaType: r.mediaType, data });
  }
  return { ok: true, images };
}

export function attachmentsDir(projectId: string): string {
  return path.join(supervisorDir(projectId), "attachments");
}

/** Built from a validated id and the fixed extension map — a record cannot steer it. */
export function attachmentPath(projectId: string, a: Pick<MessageAttachment, "id" | "mediaType">): string {
  if (!UUID_RE.test(a.id) || !isImageType(a.mediaType)) throw new Error("invalid attachment");
  return path.join(attachmentsDir(projectId), `${a.id}.${IMAGE_EXT[a.mediaType]}`);
}

export function readAttachment(projectId: string, a: MessageAttachment): Buffer | null {
  try {
    return readFileSync(attachmentPath(projectId, a));
  } catch {
    return null;
  }
}

function writePrivate(file: string, data: Buffer): void {
  const fd = openSync(file, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Delete attachment files none of the last `KEEP_ATTACHMENTS_FOR_LAST` messages names. Never throws. */
export function pruneAttachments(projectId: string): void {
  const dir = attachmentsDir(projectId);
  if (!existsSync(dir)) return;
  try {
    const keep = new Set(listMessages(projectId, { limit: KEEP_ATTACHMENTS_FOR_LAST }).flatMap((m) => (m.attachments ?? []).map((a) => a.id)));
    for (const f of readdirSync(dir)) {
      const id = f.replace(/\.(png|jpg)$/, "");
      if (UUID_RE.test(id) && !keep.has(id)) unlinkSync(path.join(dir, f));
    }
  } catch {
    /* pruning is housekeeping; a failure must not refuse the user's message */
  }
}

/** Which messages a wake was for. */
export interface MessageOrigin {
  kind: "message";
  messageIds: string[];
}

/** ADR-0128 §5 — a report's origin: the follow whose tab's trigger started the wake. */
export interface FollowOrigin {
  kind: "follow";
  followId: string;
}

export type ReplyOrigin = MessageOrigin | FollowOrigin;

/** ADR-0128 §5 — what a reply links to, resolved by the server. `label` is server-built, never the supervisor's prose. */
export interface MessageRef {
  kind: "tab" | "ledger" | "item";
  id: string;
  label: string;
}

export const MAX_REPLY_REFS = 10;

export interface SupervisorMessage {
  id: string;
  at: string;
  from: "user" | "supervisor";
  text: string;
  /** `report`: a follow's report — the one reply with no user message before it (ADR-0128 §5). */
  kind?: "report";
  /** A reply's wake (ADR-0128 §5). */
  wakeId?: string;
  /** A reply's origin: the user messages its wake carried, or the follow it reports on. */
  origin?: ReplyOrigin;
  /** ADR-0128 §3 — the inbox items this reply's wake raised for its messages or follow, filtered by the server. Rendered as cards under it. */
  items?: string[];
  /** ADR-0128 §5 — tabs, ledger lines and inbox items the reply mentions; only the ones the server resolved. */
  refs?: MessageRef[];
  /** ADR-0129 — a user message's images. No path: the route layer adds one for the app. */
  attachments?: MessageAttachment[];
}

export function messagesPath(projectId: string): string {
  return path.join(supervisorDir(projectId), "messages.jsonl");
}

function append(projectId: string, m: SupervisorMessage): SupervisorMessage {
  ensureSupervisorDir(projectId);
  const fd = openSync(messagesPath(projectId), "a", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(m)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Ids only: this bus reaches `/api/chat/announce`, which holds no token.
  announceProjectEvent({ event: "supervisor.message", data: { projectId, id: m.id, from: m.from } });
  return m;
}

function readOrigin(o: unknown): ReplyOrigin | null {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (r.kind === "message" && Array.isArray(r.messageIds) && r.messageIds.every((x) => typeof x === "string")) return { kind: "message", messageIds: [...(r.messageIds as string[])] };
  if (r.kind === "follow" && typeof r.followId === "string" && r.followId) return { kind: "follow", followId: r.followId };
  return null;
}

function readAttachments(v: unknown): MessageAttachment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((a): a is MessageAttachment => !!a && typeof a === "object" && typeof a.id === "string" && UUID_RE.test(a.id) && isImageType(a.mediaType) && Number.isInteger(a.bytes) && a.bytes > 0)
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .map((a) => ({ id: a.id, mediaType: a.mediaType, bytes: a.bytes }));
}

function readRefs(v: unknown): MessageRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((r): r is MessageRef => !!r && typeof r === "object" && ["tab", "ledger", "item"].includes((r as MessageRef).kind) && typeof (r as MessageRef).id === "string" && typeof (r as MessageRef).label === "string")
    .slice(0, MAX_REPLY_REFS)
    .map((r) => ({ kind: r.kind, id: r.id, label: r.label }));
}

export function listMessages(projectId: string, opts: { limit?: number } = {}): SupervisorMessage[] {
  const p = messagesPath(projectId);
  if (!existsSync(p)) return [];
  const out: SupervisorMessage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as SupervisorMessage;
      if (!m?.id || (m.from !== "user" && m.from !== "supervisor") || typeof m.text !== "string") continue;
      const origin = readOrigin(m.origin);
      const refs = readRefs(m.refs);
      const attachments = m.from === "user" ? readAttachments(m.attachments) : [];
      out.push({
        id: m.id,
        at: m.at,
        from: m.from,
        text: m.text,
        ...(m.from === "supervisor" && m.kind === "report" ? { kind: "report" as const } : {}),
        ...(typeof m.wakeId === "string" ? { wakeId: m.wakeId } : {}),
        ...(origin ? { origin } : {}),
        ...(Array.isArray(m.items) && m.items.length && m.items.every((x) => typeof x === "string") ? { items: [...m.items] } : {}),
        ...(refs.length ? { refs } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
    } catch {
      /* a torn final line */
    }
  }
  return opts.limit !== undefined ? out.slice(-opts.limit) : out;
}

export function addUserMessage(projectId: string, text: string, images: readonly ImageInput[] = []): SupervisorMessage {
  const attachments: MessageAttachment[] = [];
  const written: string[] = [];
  try {
    if (images.length) {
      ensureSupervisorDir(projectId);
      const dir = attachmentsDir(projectId);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o700);
    }
    // Every file first, then the line: a line never names a file that is not there.
    for (const img of images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
      const a: MessageAttachment = { id: randomUUID(), mediaType: img.mediaType, bytes: img.data.length };
      const file = attachmentPath(projectId, a);
      writePrivate(file, img.data);
      written.push(file);
      attachments.push(a);
    }
    const m = append(projectId, {
      id: randomUUID(),
      at: new Date().toISOString(),
      from: "user",
      text: text.slice(0, MAX_USER_MESSAGE_CHARS),
      ...(attachments.length ? { attachments } : {}),
    });
    pruneAttachments(projectId);
    return m;
  } catch (err) {
    for (const f of written) {
      try {
        unlinkSync(f);
      } catch {
        /* already gone */
      }
    }
    throw err;
  }
}

export function addSupervisorReply(
  projectId: string,
  text: string,
  wake?: { wakeId: string; origin: ReplyOrigin; items?: readonly string[] | undefined; refs?: readonly MessageRef[] | undefined },
): SupervisorMessage {
  const origin = wake ? readOrigin(wake.origin) : null;
  const refs = readRefs(wake?.refs);
  return append(projectId, {
    id: randomUUID(),
    at: new Date().toISOString(),
    from: "supervisor",
    text: text.slice(0, MAX_USER_MESSAGE_CHARS),
    ...(origin?.kind === "follow" ? { kind: "report" as const } : {}),
    ...(wake ? { wakeId: wake.wakeId } : {}),
    ...(origin ? { origin } : {}),
    ...(wake?.items?.length ? { items: [...wake.items] } : {}),
    ...(refs.length ? { refs } : {}),
  });
}

/** A user message by id — what `new_session` cites as the request. A supervisor reply is never a request. */
export function getUserMessage(projectId: string, id: string): SupervisorMessage | null {
  return listMessages(projectId).find((m) => m.id === id && m.from === "user") ?? null;
}

/**
 * User messages no reply answers, oldest first. A reply answers the messages
 * its `origin` names; a reply written before milestone 7 carries no origin and
 * answers everything before it.
 */
export function unansweredUserMessages(projectId: string): SupervisorMessage[] {
  const all = listMessages(projectId);
  const answered = new Set<string>();
  let legacyCut = -1;
  all.forEach((m, i) => {
    if (m.from !== "supervisor") return;
    // A follow's report answers no user message.
    if (m.origin?.kind === "message") for (const id of m.origin.messageIds) answered.add(id);
    else if (!m.origin) legacyCut = i;
  });
  return all.filter((m, i) => m.from === "user" && i > legacyCut && !answered.has(m.id));
}
