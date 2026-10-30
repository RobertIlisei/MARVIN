/**
 * ADR-0127 §5 — the side doors a tab's model must not use.
 *
 * MARVIN's control routes (`/api/confirm`, `/api/chat`, `/api/supervisor`, …)
 * are guarded only by a static header a tab's shell can present, and the
 * supervisor's data directory holds its capability token, state and ledger.
 * From inside a tab, either is a way for a model to answer its own confirm,
 * delegate itself, or message another tab as the supervisor. Both are a hard
 * deny, so they hold in `auto` and `full` as in `gated` — and the runtime
 * applies this from the executor's PreToolUse hook too, because Read / Grep /
 * Glob never reach the permission callback.
 *
 * Matched on what a call NAMES, after URL-decoding and collapsing repeated
 * slashes:
 *   - the sidecar's port followed by a control path, on ANY host spelling —
 *     the sidecar binds loopback only, so `127.1`, `0`, a decimal IP or
 *     `lvh.me` are all just loopback in disguise;
 *   - a network tool (`nc`, `socat`, `node -e`, `curl`, …) whose command holds
 *     the port anywhere and a control path anywhere — a raw request line
 *     carries no port;
 *   - the data directory's `supervisor/` folder in any of its spellings.
 * A model that hides the path (a variable, a glob, `$(cat file)`, a relative
 * path) evades any string rule; ADR-0127 §5 states that limit and what makes
 * a bypass detectable. `/api/health` stays open; other ports are untouched.
 */

import { homedir } from "node:os";
import path from "node:path";

import type { ToolPolicyClass } from "./policy";

const CONTROL = "(?:supervisor|confirm|chat|sessions|worktrees|models/roles)(?![a-z])";
/** A network tool in command position (so `grep "http://…"` is not one). */
const NETWORK_TOOL_RE =
  /(?:^|[\s|;&(])(?:nc|ncat|netcat|socat|telnet|curl|wget|http|xh)\s|\/dev\/(?:tcp|udp)\/|(?:^|[\s|;&(])(?:node|deno|bun)\s+(?:-e|--eval|-p)\s|(?:^|[\s|;&(])python3?\s+-c\s|(?:^|[\s|;&(])(?:ruby|perl)\s+-e\s/i;

const G = globalThis as typeof globalThis & { __marvinSidecarPort?: string };

/**
 * The port the sidecar actually serves on, as the first request saw it —
 * preferred over the environment. First wins: a later request carrying a
 * forged `Host` header cannot move the port this rule protects.
 */
export function noteSidecarPort(port: string | null | undefined): void {
  if (!G.__marvinSidecarPort && port && /^\d{2,5}$/.test(port)) G.__marvinSidecarPort = port;
}

export function sidecarPort(): string {
  if (G.__marvinSidecarPort) return G.__marvinSidecarPort;
  const p = (process.env.PORT ?? process.env.MARVIN_PORT ?? "3030").trim();
  return /^\d{2,5}$/.test(p) ? p : "3030";
}

/** Test seam: forget a port noted by an earlier request. */
export function resetNotedSidecarPortForTests(): void {
  delete G.__marvinSidecarPort;
}

function dataDir(): string {
  const raw = process.env.MARVIN_DATA_DIR?.trim();
  return raw ? path.resolve(raw) : path.resolve(process.env.HOME ?? homedir(), ".marvin");
}

function normalise(s: string): string {
  let out = s;
  for (let i = 0; i < 3; i += 1) {
    try {
      const d = decodeURIComponent(out);
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out.replace(/\/{2,}/g, "/");
}

function namesControlRoute(s: string, port: string): boolean {
  const n = normalise(s);
  if (new RegExp(`:${port}/api/${CONTROL}`, "i").test(n)) return true;
  return NETWORK_TOOL_RE.test(n) && new RegExp(`(?<![0-9])${port}(?![0-9])`).test(n) && new RegExp(`/api/${CONTROL}`, "i").test(n);
}

function namesSupervisorDir(s: string): boolean {
  const n = normalise(s);
  const d = dataDir();
  return [
    `${d}/supervisor`,
    "~/.marvin/supervisor",
    "$HOME/.marvin/supervisor",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell spelling a command may contain
    "${HOME}/.marvin/supervisor",
    "$MARVIN_DATA_DIR/supervisor",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal shell spelling a command may contain
    "${MARVIN_DATA_DIR}/supervisor",
  ].some((m) => n.includes(m));
}

const deny = (reason: string): { class: ToolPolicyClass; reason: string } => ({ class: "deny", reason });

/** A hard deny for a tab tool call that names a side door, or null. */
export function supervisorBoundaryDenial(name: string, input: Record<string, unknown> | undefined): { class: ToolPolicyClass; reason: string } | null {
  if (!input || typeof input !== "object") return null;
  const strings: string[] = [];
  for (const key of ["command", "url", "file_path", "notebook_path", "path", "pattern", "glob"]) {
    const v = input[key];
    if (typeof v === "string" && v) strings.push(v);
  }
  if (strings.length === 0) return null;

  const port = sidecarPort();
  if ((name === "Bash" || name === "WebFetch") && strings.some((s) => namesControlRoute(s, port))) {
    return deny(
      "Refused (ADR-0127): a tab may not drive MARVIN's own control API (confirm, chat, sessions, worktrees, " +
        "roles, supervisor). Answering a confirm or messaging a tab is the user's act, or the supervisor's through " +
        "its own policy — never a tab's. `/api/health` stays open.",
    );
  }
  if (strings.some(namesSupervisorDir)) {
    return deny("Refused (ADR-0127): the supervisor's data directory (its token, state and ledger) is off limits to a tab.");
  }
  return null;
}
