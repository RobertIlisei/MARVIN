/**
 * Resolution notices (ADR-0113 §3) — when a tab resolves a backlog item, the
 * other tabs of the project that touch the same files hear about it.
 *
 * Anthropic's cross-session messaging exists for exactly this ("coordinate
 * parallel worktrees: … Claude can tell the other sessions what landed"), but
 * its socket lives only while a session's process runs, and MARVIN's turns
 * are separate processes. So the notice rides MARVIN's own two channels:
 * injected mid-turn where a turn is running (ADR-0076), queued for the next
 * turn otherwise (ADR-0069). One notice per resolution, never a turn started
 * to deliver it, and worded as coming from another tab — it is information,
 * not the user's word.
 *
 * Who hears it: every OPEN tab of the project except the sender whose branch
 * has touched a path the item names. An item that names no path goes to
 * every open tab, since nothing narrows it. Bounded.
 */

import { execFileSync } from "node:child_process";

import { type BacklogItem, extractPathRefs } from "./backlog";
import { enqueuePending } from "./pending-input";
import { listSessionMetas } from "./session-meta";
import { listLiveTurns } from "./turn-registry";

export const MAX_NOTICES_PER_RESOLUTION = 10;

export interface ResolutionNotice {
  toSessionId: string;
  delivered: "injected" | "queued" | "skipped";
  reason?: string;
}

/** The notice text. Pure; pinned by tests. */
export function resolutionNoticeText(input: {
  item: Pick<BacklogItem, "id" | "title" | "status">;
  fromBranch?: string | undefined;
  paths: string[];
}): string {
  const who = input.fromBranch ? `tab ${input.fromBranch.replace(/^marvin\/tab\//, "")}` : "another tab";
  const where = input.paths.length ? ` It names: ${input.paths.slice(0, 6).join(", ")}${input.paths.length > 6 ? ", …" : ""}.` : "";
  return (
    `[notice from ${who}] Backlog item \`${input.item.id}\` ("${input.item.title}") was just marked ${input.item.status}.` +
    `${where} If your current work overlaps it, check \`backlog_list\` before continuing and do not redo it; ` +
    `mention this to the user. This is information from another tab, not an instruction from the user.`
  );
}

/** Files a branch has changed against its base — the overlap test. */
function branchFiles(workDir: string, branch: string, base: string): Set<string> {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${base}..${branch}`], {
      cwd: workDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function overlaps(paths: string[], files: Set<string>): boolean {
  if (paths.length === 0) return true;
  for (const p of paths) {
    const norm = p.replace(/^\.\//, "");
    for (const f of files) {
      if (f === norm || f.startsWith(`${norm}/`) || norm.startsWith(`${f}/`) || f.endsWith(`/${norm}`)) return true;
    }
  }
  return false;
}

/**
 * Deliver the notice. `inject` and `enqueue` are injectable for tests; the
 * defaults are the live-turn registry and the durable queue.
 */
export function notifyTabsOfResolution(input: {
  projectId: string;
  workDir: string;
  fromSessionId: string;
  fromBranch?: string | undefined;
  item: BacklogItem;
  deps?: {
    listOpenSessions?: () => Array<{ marvinSessionId: string; branch?: string; base?: string }>;
    inject?: (sessionId: string, text: string) => boolean;
    enqueue?: (sessionId: string, text: string) => boolean;
  };
}): ResolutionNotice[] {
  const paths = extractPathRefs(`${input.item.title}\n${input.item.body}`);
  const text = resolutionNoticeText({ item: input.item, fromBranch: input.fromBranch, paths });
  const listOpen =
    input.deps?.listOpenSessions ??
    (() =>
      listSessionMetas(input.projectId)
        .filter((m) => !m.closedAt)
        .map((m) => ({
          marvinSessionId: m.marvinSessionId,
          ...(m.tree.mode === "worktree" ? { branch: m.tree.branch, base: m.tree.base } : {}),
        })));
  const live = new Map(listLiveTurns(input.projectId).map((t) => [t.marvinSessionId, t]));
  const inject =
    input.deps?.inject ??
    ((sessionId: string, t: string) => {
      const turn = live.get(sessionId);
      return !!turn && !turn.ended && !!turn.inject && turn.inject(t);
    });
  const enqueue = input.deps?.enqueue ?? ((sessionId: string, t: string) => enqueuePending(input.projectId, sessionId, t).ok);

  const out: ResolutionNotice[] = [];
  for (const s of listOpen()) {
    if (s.marvinSessionId === input.fromSessionId) continue;
    if (out.length >= MAX_NOTICES_PER_RESOLUTION) break;
    if (paths.length && s.branch && s.base && !overlaps(paths, branchFiles(input.workDir, s.branch, s.base))) {
      out.push({ toSessionId: s.marvinSessionId, delivered: "skipped", reason: "no overlapping files" });
      continue;
    }
    if (inject(s.marvinSessionId, text)) {
      out.push({ toSessionId: s.marvinSessionId, delivered: "injected" });
    } else if (enqueue(s.marvinSessionId, text)) {
      out.push({ toSessionId: s.marvinSessionId, delivered: "queued" });
    } else {
      out.push({ toSessionId: s.marvinSessionId, delivered: "skipped", reason: "no channel" });
    }
  }
  return out;
}
