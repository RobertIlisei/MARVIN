/**
 * The user's conversation with the supervisor (ADR-0127 §2, plan milestone 5).
 *
 * `POST /api/supervisor/message` appends the user's message and wakes the
 * supervisor; its `reply` verb appends the answer. The conversation **grants
 * nothing**: "approve X" here produces at most an escalation, and consent is
 * given only on the raw act in the inbox (§5). A user message is the one
 * request `new_session` accepts — one message, one tab.
 *
 * Append-only JSONL beside the ledger, 0600, under the data dir.
 */

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

import { ensureSupervisorDir, supervisorDir } from "./supervisor-ledger";

export const MAX_USER_MESSAGE_CHARS = 4_000;

export interface SupervisorMessage {
  id: string;
  at: string;
  from: "user" | "supervisor";
  text: string;
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
  return m;
}

export function listMessages(projectId: string, opts: { limit?: number } = {}): SupervisorMessage[] {
  const p = messagesPath(projectId);
  if (!existsSync(p)) return [];
  const out: SupervisorMessage[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line) as SupervisorMessage;
      if (m?.id && (m.from === "user" || m.from === "supervisor") && typeof m.text === "string") out.push(m);
    } catch {
      /* a torn final line */
    }
  }
  return opts.limit !== undefined ? out.slice(-opts.limit) : out;
}

export function addUserMessage(projectId: string, text: string): SupervisorMessage {
  return append(projectId, { id: randomUUID(), at: new Date().toISOString(), from: "user", text: text.slice(0, MAX_USER_MESSAGE_CHARS) });
}

export function addSupervisorReply(projectId: string, text: string): SupervisorMessage {
  return append(projectId, { id: randomUUID(), at: new Date().toISOString(), from: "supervisor", text: text.slice(0, MAX_USER_MESSAGE_CHARS) });
}

/** A user message by id — what `new_session` cites as the request. A supervisor reply is never a request. */
export function getUserMessage(projectId: string, id: string): SupervisorMessage | null {
  return listMessages(projectId).find((m) => m.id === id && m.from === "user") ?? null;
}
