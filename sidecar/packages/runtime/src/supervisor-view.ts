/**
 * The supervisor's records as the UI reads them (ADR-0127 milestone 5, design
 * brief §10.5 and §10.6).
 *
 * Lines on disk are never rewritten (append-only), so the read shape is a
 * projection: `seq` is a line's position, `actor` derives from its `kind`, the
 * stored `tab` / `argsDigest` are named `sessionId` / `argDigest`, and a line
 * written before milestone 3 has no `reasonCode` and projects
 * `code: "unspecified"`.
 *
 * A Ground is resolved again at read time for its label, excerpt and a path
 * the app can open. A secret file (the patterns in `fs-constants.ts`) is
 * never excerpted or offered for opening, whatever the ground cites.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { hasDenySegment, isSecretFileName } from "@marvin/tools/fs-constants";

import { readSessionMeta } from "./session-meta";
import type { LedgerEntry, LedgerGround } from "./supervisor-ledger";
import { getSupervisorState } from "./supervisor-state";

// ── Ground (§10.6) ───────────────────────────────────────────────────────────

export const GROUND_FIELDS = ["kind", "ref", "tree", "label", "provenance", "resolved", "excerpt", "openTarget"] as const;

export interface Ground {
  kind: "plan-step" | "dod" | "adr" | "memory" | "charter" | "file";
  ref: string;
  /** `main`, or the session id whose checkout a file ref lives in. */
  tree: string;
  label: string;
  provenance: "strong" | "weak";
  resolved: boolean;
  excerpt: string | null;
  openTarget: { path: string; line?: number } | null;
}

/** What a ground is projected against: the project root, the charter, and per tab its tree and brief. */
export interface GroundViewContext {
  mainRoot: string;
  charter: string;
  /** A tab's worktree path, or null for a shared tab or an unknown one. */
  tabRoot(sessionId: string): string | null;
  brief(sessionId: string): string | null;
}

/** The routes' context: the project root, the charter, and each tab's tree from its session meta. */
export function groundViewContextFor(projectId: string, workDir: string): GroundViewContext {
  return {
    mainRoot: workDir,
    charter: getSupervisorState(projectId).charter,
    tabRoot: (id) => {
      const tree = readSessionMeta(projectId, id)?.tree;
      return tree?.mode === "worktree" ? tree.path : null;
    },
    brief: () => null,
  };
}

const EXCERPT_MAX = 200;
const ADR_DIRS = ["docs/decisions", "docs/adr", "docs/adrs"];
const cap = (s: string) => (s.length > EXCERPT_MAX ? `${s.slice(0, EXCERPT_MAX - 1)}…` : s);

function secretPath(abs: string): boolean {
  return isSecretFileName(path.basename(abs)) || hasDenySegment(abs);
}

/**
 * A file inside `root`, existing, not secret — or null. Symlinks are followed
 * before both checks: a link in the repository to `~/.ssh/id_ed25519` is the
 * key, whatever the link is called (security audit, milestone 5).
 */
function openable(root: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(`${r}${path.sep}`)) return null;
  try {
    if (!existsSync(abs)) return null;
    const real = realpathSync(abs);
    const realRoot = realpathSync(r);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) return null;
    if (!statSync(real).isFile() || secretPath(real)) return null;
  } catch {
    return null;
  }
  return secretPath(abs) ? null : abs;
}

function readLine(abs: string, line: number): string | null {
  try {
    const text = readFileSync(abs, "utf8");
    const l = text.split("\n")[line - 1];
    return l === undefined ? null : l.trim();
  } catch {
    return null;
  }
}

function adrFile(root: string, num: string): string | null {
  for (const d of ADR_DIRS) {
    const dir = path.join(root, d);
    try {
      const f = readdirSync(dir).find((n) => n.startsWith(`${num}-`) && n.endsWith(".md"));
      if (f) return path.join(dir, f);
    } catch {
      /* no such dir */
    }
  }
  return null;
}

function firstHeading(abs: string): string | null {
  try {
    for (const l of readFileSync(abs, "utf8").split("\n").slice(0, 40)) {
      const m = /^#\s+(.+)$/.exec(l.trim());
      if (m?.[1]) return m[1].trim();
    }
  } catch {
    /* unreadable */
  }
  return null;
}

function firstBodyLine(abs: string): string | null {
  try {
    let inFront = false;
    for (const raw of readFileSync(abs, "utf8").split("\n").slice(0, 60)) {
      const l = raw.trim();
      if (l === "---") {
        inFront = !inFront;
        continue;
      }
      if (!inFront && l && !l.startsWith("#")) return l;
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** One stored ground, as the brief's `Ground`. `tab` is the session the ground was cited for. */
export function projectGround(g: LedgerGround, ctx: GroundViewContext & { tab: string | null }): Ground {
  const resolved = g.provenance !== "unresolved";
  const provenance: Ground["provenance"] = g.provenance === "strong" ? "strong" : "weak";
  const base = { provenance, resolved };
  switch (g.kind) {
    case "plan": {
      const n = /^(\d+(?:\.\d+)?)$/.exec(g.ref.trim())?.[1] ?? g.ref.trim();
      return { ...base, kind: "plan-step", ref: `plan:[${n}]`, tree: ctx.tab ?? "main", label: `Plan step ${n}`, excerpt: null, openTarget: null };
    }
    case "charter":
      return { ...base, kind: "charter", ref: "charter", tree: "main", label: "Charter", excerpt: resolved ? cap(g.ref) : null, openTarget: null };
    case "dod":
      return { ...base, kind: "dod", ref: "dod", tree: ctx.tab ?? "main", label: "The user's brief", excerpt: resolved ? cap(g.ref) : null, openTarget: null };
    case "adr": {
      const m = /^(?:ADR-)?(\d{1,4})$/i.exec(g.ref.trim());
      const num = m?.[1] ? m[1].padStart(4, "0") : null;
      const ref = num ? `ADR-${num}` : g.ref;
      const file = num && resolved ? adrFile(ctx.mainRoot, num) : null;
      const heading = file ? firstHeading(file) : null;
      return { ...base, kind: "adr", ref, tree: "main", label: heading ? cap(heading) : ref, excerpt: heading ? cap(heading) : null, openTarget: file ? { path: file } : null };
    }
    case "memory": {
      const slug = g.ref.trim();
      const abs = resolved && /^[a-z0-9][a-z0-9._-]{0,120}$/i.test(slug) && !slug.includes("..") ? openable(ctx.mainRoot, path.join(".marvin", "memory", `${slug}.md`)) : null;
      const line = abs ? firstBodyLine(abs) : null;
      return { ...base, kind: "memory", ref: `memory:${slug}`, tree: "main", label: `Memory: ${slug}`, excerpt: line ? cap(line) : null, openTarget: abs ? { path: abs } : null };
    }
    case "file": {
      const m = /^(main|tab):(.+?)(?::(\d+))?$/.exec(g.ref.trim());
      const which = m?.[1] === "tab" ? "tab" : "main";
      const rel = m?.[2] ?? g.ref;
      const line = m?.[3] ? Number(m[3]) : undefined;
      const root = which === "main" ? ctx.mainRoot : ctx.tab ? ctx.tabRoot(ctx.tab) : null;
      const abs = resolved && root ? openable(root, rel) : null;
      const excerpt = abs && line ? readLine(abs, line) : null;
      return {
        ...base,
        kind: "file",
        ref: `file:${rel}${line ? `:${line}` : ""}`,
        tree: which === "main" ? "main" : (ctx.tab ?? "main"),
        label: `${rel}${line ? `:${line}` : ""}`,
        excerpt: excerpt ? cap(excerpt) : null,
        openTarget: abs ? { path: abs, ...(line ? { line } : {}) } : null,
      };
    }
    default:
      return { ...base, kind: "file", ref: String(g.ref), tree: "main", label: String(g.ref), resolved: false, provenance: "weak", excerpt: null, openTarget: null };
  }
}

// ── The ledger's read shape (§10.5) ─────────────────────────────────────────

export const LEDGER_VIEW_FIELDS = [
  "seq",
  "id",
  "at",
  "wakeId",
  "actor",
  "sessionId",
  "tabTitle",
  "verb",
  "decision",
  "mode",
  "argDigest",
  "argSummary",
  "reason",
  "grounds",
  "pairing",
  "inboxItemId",
  "costUsd",
] as const;

export type LedgerActor = "supervisor" | "user" | "runtime";

/** Who a line is about: the supervisor's verbs, the user's controls and inbox acts, the runtime's loop. */
export function actorOf(e: LedgerEntry): LedgerActor {
  switch (e.kind) {
    case "verb":
      return "supervisor";
    case "control":
      // The runtime pauses a faulting supervisor and restores state at boot; the rest are the user's.
      return e.verb === "auto-pause" || e.verb === "boot" ? "runtime" : "user";
    case "inbox":
    case "message":
    case "reveal":
      return "user";
    default:
      return "runtime";
  }
}

export interface LedgerViewEntry {
  seq: number;
  id: string | null;
  at: string;
  wakeId: string | null;
  actor: LedgerActor;
  sessionId: string | null;
  tabTitle: string | null;
  verb: string;
  decision: string | null;
  mode: string | null;
  argDigest: string | null;
  argSummary: string | null;
  reason: { code: string; text: string };
  grounds: Ground[];
  pairing: { actualAnswer: string[] | null; answeredBy: "user" | "supervisor" | null; agreement: "agree" | "disagree" | "pending"; proposalSeenBeforeAnswer: boolean } | null;
  inboxItemId: string | null;
  costUsd: number | null;
}

export interface LedgerPage {
  entries: LedgerViewEntry[];
  hasMore: boolean;
  nextBefore: number | null;
  todayCount: number;
}

const PAIRED = new Set(["answer", "confirm"]);

/**
 * One page of the ledger, newest page first and oldest-first inside it.
 * `before` is a `seq` cursor; filters apply before paging.
 */
export function projectLedger(
  _projectId: string,
  all: readonly LedgerEntry[],
  opts: { before?: number | undefined; limit: number; sessionId?: string | undefined; decision?: string | undefined; groundCtx: GroundViewContext; now?: number },
): LedgerPage {
  const pairings = new Map<string, LedgerEntry>();
  const reveals = new Set<string>();
  for (const e of all) {
    if (e.kind === "pairing" && e.proposalId) pairings.set(e.proposalId, e);
    if (e.kind === "reveal" && e.proposalId) reveals.add(e.proposalId);
  }
  const matches = (e: LedgerEntry) => (opts.sessionId === undefined || e.tab === opts.sessionId) && (opts.decision === undefined || e.decision === opts.decision);
  const today = new Date(opts.now ?? Date.now()).toISOString().slice(0, 10);
  const indexed = all.map((e, seq) => ({ e, seq })).filter(({ e }) => matches(e));
  const todayCount = indexed.filter(({ e }) => typeof e.at === "string" && e.at.slice(0, 10) === today).length;
  const window = indexed.filter(({ seq }) => opts.before === undefined || seq < opts.before);
  const limit = Math.max(1, opts.limit);
  const page = window.slice(-limit);
  const hasMore = window.length > page.length;

  const entries = page.map(({ e, seq }): LedgerViewEntry => {
    let pairing: LedgerViewEntry["pairing"] = null;
    if (e.kind === "verb" && PAIRED.has(e.verb) && (e.decision === "propose" || e.decision === "act") && e.id) {
      const p = pairings.get(e.id)?.pairing;
      pairing = p
        ? { actualAnswer: p.actualAnswer, answeredBy: p.answeredBy, agreement: p.agreement, proposalSeenBeforeAnswer: p.proposalSeenBeforeAnswer }
        : { actualAnswer: null, answeredBy: null, agreement: "pending", proposalSeenBeforeAnswer: reveals.has(e.id) };
    }
    return {
      seq,
      id: e.id ?? null,
      at: e.at,
      wakeId: e.wakeId ?? null,
      actor: actorOf(e),
      sessionId: e.tab ?? null,
      tabTitle: e.tabTitle ?? null,
      verb: e.verb,
      decision: e.decision ?? null,
      mode: e.mode ?? null,
      argDigest: e.argsDigest ?? null,
      argSummary: e.argSummary ?? null,
      reason: { code: e.reasonCode ?? "unspecified", text: e.reason },
      grounds: (e.grounds ?? []).map((g) => projectGround(g, { ...opts.groundCtx, tab: e.tab ?? null })),
      pairing,
      inboxItemId: e.inboxItemId ?? null,
      costUsd: typeof e.costUsd === "number" ? e.costUsd : null,
    };
  });
  return { entries, hasMore, nextBefore: hasMore && page[0] ? page[0].seq : null, todayCount };
}
