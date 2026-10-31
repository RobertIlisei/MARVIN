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
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

import { ensureSupervisorDir, supervisorDir } from "./supervisor-ledger";
import { announceProjectEvent } from "./turn-registry";

export const MAX_USER_MESSAGE_CHARS = 4_000;

/** Which messages a wake was for. Milestone [7.3] adds `{kind: "follow", followId}`. */
export interface MessageOrigin {
  kind: "message";
  messageIds: string[];
}

export interface SupervisorMessage {
  id: string;
  at: string;
  from: "user" | "supervisor";
  text: string;
  /** A reply's wake (ADR-0128 §5). */
  wakeId?: string;
  /** A reply's origin: the user messages its wake carried. */
  origin?: MessageOrigin;
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

const validOrigin = (o: unknown): o is MessageOrigin =>
  !!o && typeof o === "object" && (o as MessageOrigin).kind === "message" && Array.isArray((o as MessageOrigin).messageIds) && (o as MessageOrigin).messageIds.every((x) => typeof x === "string");

export function listMessages(projectId: string, opts: { limit?: number } = {}): SupervisorMessage[] {
  const p = messagesPath(projectId);
  if (!existsSync(p)) return [];
  const out: SupervisorMessage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as SupervisorMessage;
      if (!m?.id || (m.from !== "user" && m.from !== "supervisor") || typeof m.text !== "string") continue;
      out.push({
        id: m.id,
        at: m.at,
        from: m.from,
        text: m.text,
        ...(typeof m.wakeId === "string" ? { wakeId: m.wakeId } : {}),
        ...(validOrigin(m.origin) ? { origin: { kind: "message", messageIds: [...m.origin.messageIds] } } : {}),
      });
    } catch {
      /* a torn final line */
    }
  }
  return opts.limit !== undefined ? out.slice(-opts.limit) : out;
}

export function addUserMessage(projectId: string, text: string): SupervisorMessage {
  return append(projectId, { id: randomUUID(), at: new Date().toISOString(), from: "user", text: text.slice(0, MAX_USER_MESSAGE_CHARS) });
}

export function addSupervisorReply(projectId: string, text: string, wake?: { wakeId: string; origin: MessageOrigin }): SupervisorMessage {
  return append(projectId, {
    id: randomUUID(),
    at: new Date().toISOString(),
    from: "supervisor",
    text: text.slice(0, MAX_USER_MESSAGE_CHARS),
    ...(wake ? { wakeId: wake.wakeId, origin: { kind: "message", messageIds: [...wake.origin.messageIds] } } : {}),
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
    if (m.origin) for (const id of m.origin.messageIds) answered.add(id);
    else legacyCut = i;
  });
  return all.filter((m, i) => m.from === "user" && i > legacyCut && !answered.has(m.id));
}
