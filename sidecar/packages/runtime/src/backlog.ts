/**
 * Project backlog store (ADR-0044) — a durable, per-project parking lot for
 * deferred-work items "noticed in flight, not in scope".
 *
 * Mirrors the durable-facts memory layer (`memory-mcp.ts`, ADR-0042): one item
 * → one small file under `<workDir>/.marvin/backlog/<slug>.md` + a one-line
 * index at `<workDir>/.marvin/backlog.md` (open + doing only). The deliberate
 * difference from memory is that this is a SHARED store: both the `marvin-backlog`
 * MCP tool (the model write path) AND the `/api/backlog` routes (the macOS UI)
 * read/write through here, so the file logic lives in one place.
 *
 * It is a PARKING LOT, not a Kanban board (Golden Rule 1): nothing here is
 * pulled by a subagent or executed autonomously. Bounded at the write boundary
 * (caps + content-class rejection in `classifyBacklogText`) — the ADR-0042
 * lesson that prose guidance alone let memory bloat to 419 KB.
 *
 * Scoped to the active project's workDir — never MARVIN's own repo.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INDEX_HEADER = "# Project Backlog";
export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_CHARS = 2000;
/** Open+doing rail — a guard against a runaway queue, not a workload target. */
export const MAX_OPEN_ITEMS = 50;

export const BACKLOG_STATUSES = ["open", "doing", "done", "dismissed"] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];
export const BACKLOG_SEVERITIES = ["low", "med", "high"] as const;
export type BacklogSeverity = (typeof BACKLOG_SEVERITIES)[number];

export interface BacklogItem {
  id: string; // slug
  title: string;
  body: string;
  status: BacklogStatus;
  severity: BacklogSeverity;
  /** Session that parked it (best-effort link back); empty for manual UI adds. */
  sessionId: string;
  created: string; // ISO
  updated: string; // ISO
}

export interface AddBacklogInput {
  title: string;
  body?: string;
  severity?: BacklogSeverity;
  sessionId?: string;
}

export type AddBacklogResult =
  | { ok: true; item: BacklogItem; created: boolean }
  | { ok: false; error: string };

export type ResolveResult =
  | { ok: true; item: BacklogItem }
  | { ok: false; error: string };

/**
 * Content-class gate for the MODEL write path (the MCP tool). A backlog item is
 * an *actionable, scoped follow-up* — not a durable fact (→ `remember`), not
 * verification/commit status (→ git), not a decision (→ ADR). Pure + exported
 * so it's unit-testable at the boundary, like memory's BANNED_PATTERNS.
 */
const BANNED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\bnot committed\b|\bnot pushed\b|\bcommitted\/pushed\b/i, why: "commit state lives in git, not a backlog" },
  { re: /\bvitest\b|\btsc clean\b|\beslint\b|\b\d+\/\d+ (tests|passing)\b|\ball tests pass\b/i, why: "test/verification status is ephemeral (→ git/CI)" },
  { re: /\bwe (chose|decided|will use)\b|\bdecision:\s|\bas-built\b/i, why: "a decision belongs in an ADR, not a backlog" },
];

export function classifyBacklogText(
  title: string,
  body: string,
): { ok: true } | { ok: false; why: string } {
  const haystack = `${title}\n${body}`;
  for (const { re, why } of BANNED_PATTERNS) {
    if (re.test(haystack)) return { ok: false, why };
  }
  return { ok: true };
}

function slugify(title: string): string {
  const mapped = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = mapped.replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return trimmed || "item";
}

function backlogDir(workDir: string): string {
  return join(workDir, ".marvin", "backlog");
}
function indexFile(workDir: string): string {
  return join(workDir, ".marvin", "backlog.md");
}

function parseField(content: string, field: string): string {
  return new RegExp(`^${field}:\\s*(.*)$`, "m").exec(content)?.[1]?.trim() ?? "";
}

function parseItem(slug: string, content: string): BacklogItem {
  const bodyStart = content.indexOf("\n---", 3);
  const afterFm = bodyStart >= 0 ? content.indexOf("\n", bodyStart + 1) : -1;
  const body = afterFm >= 0 ? content.slice(afterFm + 1).trim() : "";
  const statusRaw = parseField(content, "status");
  const sevRaw = parseField(content, "severity");
  return {
    id: parseField(content, "id") || slug,
    title: parseField(content, "title") || slug,
    body,
    status: (BACKLOG_STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as BacklogStatus)
      : "open",
    severity: (BACKLOG_SEVERITIES as readonly string[]).includes(sevRaw)
      ? (sevRaw as BacklogSeverity)
      : "med",
    sessionId: parseField(content, "sessionId"),
    created: parseField(content, "created"),
    updated: parseField(content, "updated"),
  };
}

function serialize(item: BacklogItem): string {
  return (
    `---\n` +
    `id: ${item.id}\n` +
    `title: ${item.title.replace(/\n/g, " ").trim()}\n` +
    `status: ${item.status}\n` +
    `severity: ${item.severity}\n` +
    `sessionId: ${item.sessionId}\n` +
    `created: ${item.created}\n` +
    `updated: ${item.updated}\n` +
    `---\n\n${item.body || item.title}\n`
  );
}

async function readAll(workDir: string): Promise<BacklogItem[]> {
  const dir = backlogDir(workDir);
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const items: BacklogItem[] = [];
  for (const f of files.sort()) {
    try {
      const content = await readFile(join(dir, f), "utf-8");
      items.push(parseItem(f.replace(/\.md$/, ""), content));
    } catch {
      /* skip unreadable */
    }
  }
  return items;
}

const STATUS_MARK: Record<BacklogStatus, string> = {
  open: "[ ]",
  doing: "[~]",
  done: "[x]",
  dismissed: "[-]",
};

/**
 * Rebuild `.marvin/backlog.md` from the item files. Lists only open + doing
 * (active work); done/dismissed drop from the index but keep their files as
 * history. Returns the active count.
 */
export async function rewriteBacklogIndex(workDir: string): Promise<number> {
  const active = (await readAll(workDir))
    .filter((i) => i.status === "open" || i.status === "doing")
    .sort((a, b) => {
      const order = { high: 0, med: 1, low: 2 } as const;
      return order[a.severity] - order[b.severity] || a.created.localeCompare(b.created);
    });
  const lines = active.map(
    (i) => `- ${STATUS_MARK[i.status]} (${i.severity}) ${i.title} — backlog/${i.id}.md`,
  );
  const body =
    `${INDEX_HEADER}\n\n` +
    `Parked follow-ups (open + in-progress). One line per item; details in ` +
    `\`.marvin/backlog/<slug>.md\`. A PARKING LOT, not a queue agents pull from ` +
    `(ADR-0044) — resolve via the \`backlog_resolve\` tool or the backlog panel; ` +
    `done/dismissed items drop from this index (files kept).\n\n` +
    (lines.length ? lines.join("\n") : "_No open backlog items._") +
    "\n";
  await writeFile(indexFile(workDir), body, "utf-8");
  return active.length;
}

export async function listBacklog(
  workDir: string,
  opts?: { status?: BacklogStatus },
): Promise<BacklogItem[]> {
  const all = await readAll(workDir);
  return opts?.status ? all.filter((i) => i.status === opts.status) : all;
}

/**
 * Add (or re-open / update) a backlog item. Dedups by slug: re-adding the same
 * title updates fields in place rather than duplicating, and re-opens a
 * previously done/dismissed item. Applies length + open-count caps.
 */
export async function addBacklogItem(
  workDir: string,
  input: AddBacklogInput,
): Promise<AddBacklogResult> {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title) return { ok: false, error: "title is empty" };
  if (title.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `title is ${title.length} chars (max ${MAX_TITLE_CHARS}) — keep it to one actionable line.` };
  }
  const body = (input.body ?? "").trim();
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, error: `body is ${body.length} chars (max ${MAX_BODY_CHARS}); a backlog item is a pointer, not a doc.` };
  }
  const severity: BacklogSeverity = input.severity ?? "med";
  const slug = slugify(title);
  const dir = backlogDir(workDir);
  const path = join(dir, `${slug}.md`);
  const now = new Date().toISOString();

  const existing = existsSync(path)
    ? parseItem(slug, await readFile(path, "utf-8"))
    : null;

  // Open-count rail only applies to genuinely NEW open items.
  if (!existing) {
    const active = (await readAll(workDir)).filter(
      (i) => i.status === "open" || i.status === "doing",
    ).length;
    if (active >= MAX_OPEN_ITEMS) {
      return { ok: false, error: `backlog already has ${active} open items (cap ${MAX_OPEN_ITEMS}); resolve some before adding more.` };
    }
  }

  const item: BacklogItem = {
    id: slug,
    title,
    body,
    // Re-adding a resolved item re-opens it; an active one keeps its status.
    status: existing && (existing.status === "open" || existing.status === "doing") ? existing.status : "open",
    severity,
    sessionId: input.sessionId ?? existing?.sessionId ?? "",
    created: existing?.created || now,
    updated: now,
  };
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, serialize(item), "utf-8");
    await rewriteBacklogIndex(workDir);
    return { ok: true, item, created: !existing };
  } catch (err) {
    return { ok: false, error: `failed to write backlog item: ${(err as Error).message}` };
  }
}

/** Transition an item to a terminal status. Used by resolve + dismiss. */
export async function resolveBacklogItem(
  workDir: string,
  args: { id: string; resolution: "done" | "dismissed"; note?: string },
): Promise<ResolveResult> {
  return setBacklogStatus(workDir, args.id, args.resolution, args.note);
}

/** Set any status (e.g. `doing` when promoted to a turn). Rewrites the index. */
export async function setBacklogStatus(
  workDir: string,
  id: string,
  status: BacklogStatus,
  note?: string,
): Promise<ResolveResult> {
  const path = join(backlogDir(workDir), `${id}.md`);
  if (!existsSync(path)) return { ok: false, error: `no backlog item "${id}".` };
  const item = parseItem(id, await readFile(path, "utf-8"));
  item.status = status;
  item.updated = new Date().toISOString();
  if (note && note.trim()) {
    item.body = `${item.body}\n\n> ${status} — ${note.trim()}`.trim().slice(0, MAX_BODY_CHARS);
  }
  try {
    await writeFile(path, serialize(item), "utf-8");
    await rewriteBacklogIndex(workDir);
    return { ok: true, item };
  } catch (err) {
    return { ok: false, error: `failed to update backlog item: ${(err as Error).message}` };
  }
}
