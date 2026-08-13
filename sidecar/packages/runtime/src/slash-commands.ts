/**
 * Slash-command catalog for the composer's autocomplete.
 *
 * The SDK registers every skill, built-in command, and plugin command as a
 * slash command, and `query().supportedCommands()` returns them with the rich
 * shape the UI needs — `{ name, description, argumentHint }`. That is exactly
 * what Claude Code's terminal autocomplete renders.
 *
 * MARVIN never consumed it: the chat input passes `/foo` straight through to
 * the SDK (which handles it correctly), but the composer offered no
 * autocomplete, no descriptions, and no validation — so a slash command only
 * worked if you already knew its exact name, and a typo silently became a
 * normal chat message.
 *
 * The `system/init` event carries `slash_commands` too, but as bare
 * `string[]` — names only, no descriptions. So the catalog is captured from
 * `supportedCommands()` during a turn and cached here, keyed by workspace.
 *
 * Cached to disk as well as memory because the useful moment is BEFORE the
 * first turn of a session: a user opening a fresh chat should get autocomplete
 * immediately, from the last known catalog, rather than after they've already
 * sent a message.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { marvinPaths } from "./paths";
import { buildSkillsIndex } from "./skills-index";

export interface SlashCommandInfo {
  /** Command name WITHOUT the leading slash. */
  name: string;
  description: string;
  /** e.g. "<file>" — rendered as a dim hint after the name. */
  argumentHint: string;
}

export interface SlashCommandCatalog {
  commands: SlashCommandInfo[];
  /** ISO timestamp of the capture, so the UI can show staleness if it wants. */
  capturedAt: string;
}

/** Bound on what we persist/serve — a runaway plugin can't bloat the file. */
const MAX_COMMANDS = 500;

/** Process-local cache so repeat reads don't hit disk. Keyed by projectId. */
const memory = new Map<string, SlashCommandCatalog>();

function catalogPath(projectId: string): string {
  return join(marvinPaths.sessionsDir(projectId), "slash-commands.json");
}

/** Coerce whatever `supportedCommands()` returned into our shape. Defensive:
 *  the SDK owns that type, so anything unexpected is dropped rather than
 *  trusted. Exported for tests. */
export function normaliseCommands(raw: unknown): SlashCommandInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommandInfo[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const c = item as { name?: unknown; description?: unknown; argumentHint?: unknown };
    if (typeof c.name !== "string") continue;
    const name = c.name.replace(/^\//, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: typeof c.description === "string" ? c.description.trim() : "",
      argumentHint: typeof c.argumentHint === "string" ? c.argumentHint.trim() : "",
    });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Persist the catalog captured from a live turn. Best-effort: a failure here
 * must never affect the turn, so everything is swallowed.
 */
export function saveSlashCommands(projectId: string, raw: unknown): void {
  const commands = normaliseCommands(raw);
  if (commands.length === 0) return;
  const catalog: SlashCommandCatalog = { commands, capturedAt: new Date().toISOString() };
  memory.set(projectId, catalog);
  try {
    const p = catalogPath(projectId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(catalog), "utf-8");
  } catch {
    /* memory cache still serves this process */
  }
}

/**
 * Build a catalog straight from the filesystem — no turn required.
 *
 * The SDK capture (`supportedCommands()`) only happens DURING a turn, which
 * made the autocomplete useless exactly when you want it: open a project, type
 * `/`, get nothing until after you've already sent a message. That was a design
 * error, not a timing bug.
 *
 * Skills are discoverable without the SDK — every skill is a `SKILL.md` with
 * `name` + `description` frontmatter, which `buildSkillsIndex` already parses
 * for the Skills pane. So the composer can offer skills instantly and let the
 * richer SDK catalog (which also knows built-ins like `/debug`, `/loop`, and
 * plugin commands) merge in once a turn has run.
 */
/**
 * MARVIN's own slash commands (ADR-0063).
 *
 * The catalog is otherwise assembled from things that exist elsewhere — skills
 * on disk, plus whatever the SDK reports. A capability that lives in MARVIN's
 * runtime (an in-process MCP tool) appears in neither, so `backlog_groom`
 * shipped with no way to invoke it except describing it in a sentence. These
 * entries give those capabilities a trigger.
 *
 * `expansion` is what the SDK actually receives: a plain instruction, so the
 * command works through the normal prompt path with no special-casing in the
 * turn loop. The user's transcript keeps what they typed.
 */
export interface NativeCommand extends SlashCommandInfo {
  expansion: string;
}

export const NATIVE_COMMANDS: readonly NativeCommand[] = [
  {
    name: "groom",
    description: "Review the backlog — duplicates, stale items, unreviewed captures, dead file refs",
    argumentHint: "",
    expansion:
      "Run the `backlog_groom` tool now and relay its findings to me. " +
      "Present them grouped by kind, shortest first, and for each one say what " +
      "you'd suggest. Do NOT resolve, dismiss, merge, re-prioritise, or edit any " +
      "item, and do not start working on one — I'll decide what to act on.",
  },
];

/**
 * Expand a native command into the instruction the SDK should receive.
 * Returns null when the text isn't one, which is the overwhelmingly common
 * case — callers fall through to the message as typed.
 *
 * Matches only when the command is the WHOLE message (optionally with
 * arguments): a message that merely mentions "/groom" mid-sentence is prose,
 * not an invocation.
 */
export function expandNativeCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!head) return null;
  const cmd = NATIVE_COMMANDS.find((c) => c.name === head.toLowerCase());
  if (!cmd) return null;
  const args = rest.join(" ").trim();
  return args ? `${cmd.expansion}\n\nAdditional instruction: ${args}` : cmd.expansion;
}

export function buildFilesystemCatalog(workDir: string): SlashCommandInfo[] {
  try {
    const idx = buildSkillsIndex(workDir);
    const out: SlashCommandInfo[] = [];
    for (const s of [...idx.userGlobal, ...idx.projectLocal]) {
      if (!s?.name) continue;
      out.push({ name: s.name, description: s.description ?? "", argumentHint: "" });
    }
    return normaliseCommands(out);
  } catch {
    return [];
  }
}

/**
 * Merge the filesystem-derived skills with any SDK-captured catalog. The SDK
 * entry wins on conflict (it carries argument hints and the authoritative
 * description), but a skill present only on disk still shows up — so a freshly
 * installed skill is offered before the next turn re-captures.
 */
export function mergeCatalogs(
  captured: SlashCommandInfo[],
  filesystem: SlashCommandInfo[],
): SlashCommandInfo[] {
  const byName = new Map<string, SlashCommandInfo>();
  for (const c of filesystem) byName.set(c.name, c);
  for (const c of captured) byName.set(c.name, c);
  // Native commands last and unconditionally: they're MARVIN's own, always
  // available, and must not be shadowed by a same-named skill in some project.
  for (const c of NATIVE_COMMANDS) {
    byName.set(c.name, { name: c.name, description: c.description, argumentHint: c.argumentHint });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the catalog — memory first, then the on-disk copy from a prior
 *  session. Returns null when nothing has been captured yet. */
export function readSlashCommands(projectId: string): SlashCommandCatalog | null {
  const hit = memory.get(projectId);
  if (hit) return hit;
  try {
    const p = catalogPath(projectId);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as SlashCommandCatalog;
    const commands = normaliseCommands(parsed?.commands);
    if (commands.length === 0) return null;
    const catalog: SlashCommandCatalog = {
      commands,
      capturedAt: typeof parsed.capturedAt === "string" ? parsed.capturedAt : "",
    };
    memory.set(projectId, catalog);
    return catalog;
  } catch {
    return null;
  }
}

/**
 * Filter the catalog for a typed prefix (the text after `/`, before any
 * space). Ranking mirrors what a user expects from an autocomplete:
 * exact match, then prefix match, then substring-in-name, then description
 * match — each group alphabetical. Empty query returns everything.
 * Exported for tests.
 */
export function filterCommands(
  commands: SlashCommandInfo[],
  query: string,
  limit = 60,
): SlashCommandInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands.slice(0, limit);
  const scored: Array<{ c: SlashCommandInfo; r: number }> = [];
  for (const c of commands) {
    const r = rankCommand(c, q);
    if (r !== null) scored.push({ c, r });
  }
  scored.sort((a, b) => (a.r === b.r ? a.c.name.localeCompare(b.c.name) : a.r - b.r));
  return scored.slice(0, limit).map((s) => s.c);
}

/**
 * Rank one command against a query. Lower is better; null = no match.
 *
 * Plain substring matching is unreliable here because command names are
 * hyphenated (`improve-animations`, `emil-design-eng`) — "improveanim" and
 * "ia" are obvious intents that a substring test misses entirely. So matching
 * is layered: exact → prefix → segment prefix → substring → initials →
 * subsequence → description. Kept in lockstep with the Swift client's
 * `SlashCommandModel.rank`, which does the live per-keystroke filtering.
 * Exported for tests.
 */
export function rankCommand(c: SlashCommandInfo, q: string): number | null {
  const name = c.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  const segments = name.split("-").filter(Boolean);
  if (segments.some((seg) => seg.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  const initials = segments.map((seg) => seg[0] ?? "").join("");
  if (initials.startsWith(q)) return 4;
  if (isSubsequence(q, name.replace(/-/g, ""))) return 5;
  if (c.description.toLowerCase().includes(q)) return 6;
  return null;
}

/** True when every char of `needle` appears in `haystack` in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** Test seam. */
export function __clearSlashCommandCache(): void {
  memory.clear();
}
