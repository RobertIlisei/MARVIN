/**
 * Obsidian vault integration (ADR-0065) — the project directory AS the vault.
 *
 * MARVIN already writes a vault's worth of notes into every project it works
 * on. One real project holds 819 of them: 79 durable facts, 437 backlog items,
 * 303 plans — every one a markdown file with YAML frontmatter, which Obsidian
 * reads natively as properties. What was missing was not content. It was three
 * small things:
 *
 *   1. a `.obsidian/` folder, which is all that makes a directory a vault;
 *   2. LINKS — the notes referenced each other in prose but carried no
 *      `[[wikilinks]]`, so Obsidian's graph view showed 819 disconnected dots;
 *   3. the code graph as notes, which `graphify export obsidian` already emits.
 *
 * ## Why the project directory rather than a separate vault
 *
 * Golden Rule 4: the project's knowledge lives in the project's directory. A
 * side vault would need copying or symlinks, and every `[[link]]` would have to
 * be rewritten to survive the move. Pointing Obsidian at the project means the
 * notes MARVIN writes ARE the vault, with no synchronisation step to drift.
 *
 * ## Opt-in, and never destructive
 *
 * `.obsidian/` is created only by an explicit call — never as a side effect of
 * a turn. Writing config into someone's repository unasked is not ours to do.
 * And an EXISTING `.obsidian/` is never overwritten: the user may already have
 * a configured vault (one of this machine's registered vaults is a project
 * directory), so we merge our ignore filters into theirs and leave every other
 * setting alone.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Folders Obsidian should not index. Without these the vault is mostly
 * `node_modules`, and the graph view is unusable — the point is notes, not
 * every file in the repo.
 */
export const DEFAULT_IGNORE_FILTERS = [
  "node_modules/",
  ".git/",
  ".next/",
  ".turbo/",
  "dist/",
  "build/",
  ".build/",
  "coverage/",
  "playwright-report/",
  "graphify-out/cache/",
  // ADR-0090 — `graphify export obsidian` writes ONE NOTE PER GRAPH NODE:
  // 7,604 notes on MARVIN's own repo, ~32k on a large project, much of it AST
  // noise (`compilerOptions`, `types_4`). Left unfiltered it drowns the graph
  // view and the search index, which is the opposite of what the vault is for.
  // The notes stay on disk and are still openable by direct link.
  "graphify-out/obsidian/",
];

export interface VaultStatus {
  /** `.obsidian/` exists — the project is a vault. */
  isVault: boolean;
  /** `.obsidian/` was already there before we touched it. */
  preExisting: boolean;
  /** Counts of the note families MARVIN maintains. */
  notes: { memory: number; backlog: number; plans: number };
  /** graphify's per-node note export is present. */
  graphNotes: boolean;
  /** ADR-0091 — the single-file Canvas export. Unlike the per-symbol notes it
   *  is usable at any graph size, so it is what the index points at. */
  graphCanvas: boolean;
  /**
   * Whether a plugin is enabled that makes dot-prefixed folders visible.
   *
   * Load-bearing, not cosmetic: **Obsidian does not index dot-prefixed folders**,
   * and every note MARVIN writes lives under `.marvin/`. Without such a plugin
   * the vault opens showing `MARVIN.md` with two broken links and nothing else
   * — which is exactly the trap the first user hit. Verified 2026-08-15.
   */
  hiddenFolderPlugin: boolean;
  /** ADR-0090 — is the Dataview plugin enabled? The index note ships live
   *  query blocks only when it is; without the plugin they render as inert
   *  code fences, which is worse than not offering them. */
  dataviewPlugin: boolean;
}

/**
 * Community plugins that expose dot-folders. Matched by manifest id, taken from
 * a real vault rather than guessed.
 */
/** Where MARVIN's own notes live, relative to the vault root. */
const MARVIN_DIR = ".marvin";

/** Dataview ships under one id; an array to match the hidden-folder pattern. */
const DATAVIEW_PLUGIN_IDS: readonly string[] = ["dataview"];

export const HIDDEN_FOLDER_PLUGIN_IDS = ["hidden-folders-access", "show-hidden-files"];

const APP_JSON = "app.json";

async function countMd(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export async function vaultStatus(workDir: string): Promise<VaultStatus> {
  const dot = join(workDir, ".obsidian");
  const isVault = existsSync(dot);
  return {
    isVault,
    preExisting: isVault,
    notes: {
      memory: await countMd(join(workDir, ".marvin", "memory")),
      backlog: await countMd(join(workDir, ".marvin", "backlog")),
      plans: await countMd(join(workDir, ".marvin", "plans")),
    },
    graphNotes: existsSync(join(workDir, "graphify-out", "obsidian")),
    graphCanvas: existsSync(join(workDir, "graphify-out", "obsidian", "graph.canvas")),
    hiddenFolderPlugin: await hasHiddenFolderPlugin(dot),
    dataviewPlugin: await hasEnabledPlugin(dot, DATAVIEW_PLUGIN_IDS),
  };
}

/** Read `.obsidian/community-plugins.json` — the list of ENABLED plugin ids. */
async function hasHiddenFolderPlugin(dotDir: string): Promise<boolean> {
  return hasEnabledPlugin(dotDir, HIDDEN_FOLDER_PLUGIN_IDS);
}

/** True when any of `ids` is in the vault's enabled community plugins. */
async function hasEnabledPlugin(dotDir: string, ids: readonly string[]): Promise<boolean> {
  try {
    const raw = await readFile(join(dotDir, "community-plugins.json"), "utf-8");
    const enabled = JSON.parse(raw) as unknown;
    if (!Array.isArray(enabled)) return false;
    return enabled.some((id) => typeof id === "string" && ids.includes(id));
  } catch {
    return false;
  }
}

/**
 * Merge our ignore filters into `.obsidian/app.json`, preserving everything
 * else. Returns the filters actually added.
 *
 * Deliberately additive: a user's existing `userIgnoreFilters` are kept, and a
 * filter they removed on purpose is not silently reinstated on a later call —
 * we only add what is absent from the union of theirs and ours at write time.
 */
async function mergeIgnoreFilters(dotDir: string): Promise<string[]> {
  const path = join(dotDir, APP_JSON);
  let config: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    } catch {
      // A corrupt app.json is the user's file, not ours to replace. Bail out
      // rather than clobber it — the vault still works without our filters.
      return [];
    }
  }
  const current = Array.isArray(config.userIgnoreFilters)
    ? (config.userIgnoreFilters as string[])
    : [];
  const added = DEFAULT_IGNORE_FILTERS.filter((f) => !current.includes(f));
  if (added.length === 0 && existsSync(path)) return [];
  config.userIgnoreFilters = [...current, ...added];
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  return added;
}

/**
 * The vault's front door. Written fresh each time — it is ours, it holds no
 * user content, and it is only useful if the counts are current.
 */
export function renderIndexNote(status: VaultStatus, projectName: string): string {
  const { memory, backlog, plans } = status.notes;
  return `# ${projectName} — MARVIN

This project directory is an Obsidian vault. The notes below are written and
maintained by MARVIN as it works; you can read, link and annotate them like any
others.

${status.hiddenFolderPlugin ? "" : `> [!warning] Most of these notes are invisible right now
> Obsidian does not index folders whose name starts with a dot, and every note
> below lives under \`.marvin/\`. The links in this file will not resolve until
> you enable a plugin that exposes hidden folders:
>
> Settings → Community plugins → Browse → **"Hidden Folders Access"** → Install,
> Enable, then toggle on \`.marvin\`.

`}## What's here

- **[[memory]]** — ${memory} durable fact${memory === 1 ? "" : "s"}: invariants, gotchas and constraints the next session can't re-derive from the code.
- **[[backlog]]** — ${backlog} parked item${backlog === 1 ? "" : "s"}: work noticed in flight and deliberately deferred.
- **[[plans]]** — ${plans} plan${plans === 1 ? "" : "s"}, newest first, with checkbox progress.
${status.graphCanvas ? "- **Code graph canvas** — the whole graph as one Obsidian Canvas: `graphify-out/obsidian/graph.canvas`. Open it directly; the per-symbol notes beside it are filtered out of the vault on purpose (ADR-0090).\n" : ""}
## How to read it

Open the graph view. The three hubs are \`memory\`, \`backlog\` and \`plans\`; each links out
to its individual notes. Frontmatter (\`type\`, \`severity\`, \`kind\`, \`status\`)
shows as properties, so Obsidian's search and Dataview can filter on them.

## Live views

${status.dataviewPlugin
  ? `These tables are live — they re-query the notes every time you open this
file, so they never go stale the way a generated list would.

### Open backlog, most severe first

\`\`\`dataview
TABLE severity, kind, file.mtime AS updated
FROM "${MARVIN_DIR}/backlog"
WHERE status != "resolved"
SORT severity ASC, file.mtime DESC
LIMIT 25
\`\`\`

### Durable facts by type

\`\`\`dataview
TABLE type, file.mtime AS updated
FROM "${MARVIN_DIR}/memory"
SORT file.mtime DESC
LIMIT 25
\`\`\`

### Recently resolved

\`\`\`dataview
LIST
FROM "${MARVIN_DIR}/backlog"
WHERE status = "resolved"
SORT file.mtime DESC
LIMIT 10
\`\`\``
  : `Install the **Dataview** community plugin and re-run \`obsidian_init\` to get
live tables here — open backlog by severity, durable facts by type, and
recently resolved work. Without it these would render as code blocks, so they
are left out rather than shipped broken.`}

## What MARVIN will and won't touch

MARVIN writes \`.marvin/\` and \`graphify-out/\`. It does **not** edit notes you
create elsewhere in this vault, and it never deletes a note to tidy up — a
backlog item is resolved by changing its \`status\`, not by removing the file.

---
*Generated by MARVIN. Safe to edit — this file is regenerated, so put lasting
notes of your own somewhere else in the vault.*
`;
}

export interface InitResult {
  ok: boolean;
  created: boolean;
  ignoreFiltersAdded: string[];
  status: VaultStatus;
  error?: string;
}

/**
 * Make `workDir` an Obsidian vault, or bring an existing one up to date.
 *
 * Never overwrites `.obsidian/` wholesale and never touches a user's notes.
 */
export async function initVault(workDir: string, projectName: string): Promise<InitResult> {
  const before = await vaultStatus(workDir);
  const dot = join(workDir, ".obsidian");
  try {
    await mkdir(dot, { recursive: true });
    const ignoreFiltersAdded = await mergeIgnoreFilters(dot);
    const after = await vaultStatus(workDir);
    await writeFile(
      join(workDir, "MARVIN.md"),
      renderIndexNote(after, projectName),
      "utf-8",
    );
    return {
      ok: true,
      created: !before.isVault,
      ignoreFiltersAdded,
      status: after,
    };
  } catch (err) {
    return {
      ok: false,
      created: false,
      ignoreFiltersAdded: [],
      status: before,
      error: (err as Error).message,
    };
  }
}
