/**
 * Scope is checked, not remembered (ADR-0133 decision 5).
 *
 * An entry may carry `scopeRef: { path, heading }` — a plan document in the
 * project and the heading its id must still sit under. At open time this
 * checks, by reading the file and comparing text, that
 *  - the document resolves INSIDE the project root (no `..`, no absolute path;
 *    symlinks are followed before the check, so a link out is refused),
 *  - the entry's id still appears under that heading, and
 *  - it does not appear under a heading the project lists as deferred
 *    (`.marvin/worktree.json: deferredHeadings`, validated where read).
 *
 * No model reads the plan and nothing here executes anything: the plan, the
 * headings and the id are strings, compared. A miss returns the lines to name.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { QueueEntry } from "./supervisor-queue";
import { readWorktreeSetupConfig } from "./worktree-setup";

const MAX_PLAN_BYTES = 2 * 1024 * 1024;

export type ScopeVerdict = { ok: true } | { ok: false; reason: string; detail: string };

interface Heading {
  line: number;
  level: number;
  text: string;
}

const norm = (s: string) => s.replace(/^\s*#+\s*/, "").trim();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 119)}…` : s);

/** Headings outside fenced code, with 1-based line numbers. */
function headingsOf(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((raw, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (f) {
      const mark = (f[1] as string).charAt(0);
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (m) out.push({ line: i + 1, level: (m[1] as string).length, text: (m[2] as string).trim() });
  });
  return out;
}

/** The first line under any heading whose text is `text`, down to the next heading of the same or a higher level. */
function firstLineUnder(lines: readonly string[], headings: readonly Heading[], wanted: (h: Heading) => boolean, id: RegExp): { heading: Heading; line: number } | null {
  for (let h = 0; h < headings.length; h++) {
    const head = headings[h] as Heading;
    if (!wanted(head)) continue;
    const end = headings.slice(h + 1).find((x) => x.level <= head.level)?.line ?? lines.length + 1;
    for (let n = head.line + 1; n < end; n++) if (id.test(lines[n - 1] ?? "")) return { heading: head, line: n };
  }
  return null;
}

/** Resolve `rel` inside `workDir`, following symlinks first. Null when it escapes or is not a readable regular file. */
export function resolveInsideProject(workDir: string, rel: string): { ok: true; file: string } | { ok: false; why: string } {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return { ok: false, why: "the path must be relative and stay inside the project" };
  let root: string;
  let real: string;
  try {
    root = realpathSync(workDir);
    real = realpathSync(path.resolve(root, rel));
  } catch {
    return { ok: false, why: "the plan document does not exist" };
  }
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) return { ok: false, why: "the path resolves outside the project root" };
  try {
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_PLAN_BYTES) return { ok: false, why: "the plan document is not a regular file under 2 MB" };
  } catch {
    return { ok: false, why: "the plan document cannot be read" };
  }
  return { ok: true, file: real };
}

export function checkScopeRef(workDir: string, entry: Pick<QueueEntry, "id" | "scopeRef">): ScopeVerdict {
  const ref = entry.scopeRef;
  if (!ref) return { ok: true };
  const hold = (reason: string, detail = reason): ScopeVerdict => ({ ok: false, reason, detail });
  const at = resolveInsideProject(workDir, ref.path);
  if (!at.ok) return hold(`scopeRef ${ref.path}: ${at.why}`);
  let text: string;
  try {
    text = readFileSync(at.file, "utf8");
  } catch {
    return hold(`scopeRef ${ref.path}: the plan document cannot be read`);
  }
  const lines = text.split(/\r?\n/);
  const headings = headingsOf(lines);
  const wantText = norm(ref.heading);
  const wantedHeads = headings.filter((h) => h.text === wantText);
  if (!wantedHeads.length) return hold(`scopeRef ${ref.path}: no heading "${wantText}"`);
  const idRe = new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(entry.id)}(?![A-Za-z0-9._-])`);
  const deferred = new Set((readWorktreeSetupConfig(workDir).deferredHeadings ?? []).map(norm));
  const inDeferred = firstLineUnder(lines, headings, (h) => deferred.has(h.text), idRe);
  const inWanted = firstLineUnder(lines, headings, (h) => h.text === wantText, idRe);
  // The two lines the user needs: where the entry was supposed to sit, and where it sits now.
  const wantedLine = `${ref.path} line ${(wantedHeads[0] as Heading).line}: "${clip((wantedHeads[0] as Heading).text)}"`;
  if (inDeferred) {
    const where = `${ref.path} line ${inDeferred.line} under "${clip(inDeferred.heading.text)}" (a deferred heading): ${clip((lines[inDeferred.line - 1] ?? "").trim())}`;
    return hold(`"${entry.id}" is under the deferred heading "${clip(inDeferred.heading.text)}"`, `the brief was queued under ${wantedLine}, but now ${where}`);
  }
  if (!inWanted) return hold(`"${entry.id}" no longer appears under "${wantText}"`, `the brief was queued under ${wantedLine}, but "${entry.id}" is not under it any more`);
  return { ok: true };
}
