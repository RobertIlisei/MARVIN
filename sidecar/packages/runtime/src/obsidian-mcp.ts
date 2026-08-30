/**
 * marvin-obsidian — in-process MCP server for the vault integration (ADR-0065).
 *
 * Two tools, both scoped to the active project's workDir:
 *
 *   `obsidian_status` — is this project a vault, and what's in it?
 *   `obsidian_init`   — make it one (or refresh the index note + graph notes).
 *
 * There is deliberately no tool for READING or WRITING arbitrary vault notes.
 * Phase 1 makes what MARVIN already writes browsable; treating the user's own
 * notes as context (or writing into them) is a separate decision with its own
 * context-budget and consent questions — see ADR-0065 §"What this is not".
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { initVault, vaultStatus } from "./obsidian-vault";
import { relinkBacklogNotes, rewriteBacklogIndex } from "./backlog";
import { rewriteMemoryIndex } from "./memory-mcp";
import { rewritePlansIndex } from "./plans-index";

const run = promisify(execFile);

export interface ObsidianToolContext {
  cwd: string;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Export the code graph as one note per symbol.
 *
 * Best-effort: graphify may not be installed, and the export needs an existing
 * `graph.json`. A missing export degrades the vault (no code notes) but must
 * never fail the init — the note families MARVIN writes are the point.
 */
/**
 * Export the code graph as an Obsidian **Canvas** (ADR-0091).
 *
 * The note export writes ONE FILE PER NODE — 7,604 for MARVIN's own repo,
 * ~32k for a 31,863-node project — which is why ADR-0090 filters it out of the
 * vault. The canvas is the same graph as a SINGLE file (1.5 MB, 6,811 nodes)
 * that Obsidian renders natively. Same information, no flooding: this is the
 * graphify↔Obsidian bridge in the form that is actually usable.
 *
 * Best-effort, like the note export: graphify may be absent or the graph
 * unbuilt, and a missing canvas degrades the vault without failing the init.
 */
export async function exportGraphCanvas(cwd: string): Promise<{ ok: boolean; detail: string }> {
  try {
    // The canvas is written alongside the notes; we keep only the canvas and
    // let ADR-0090's ignore filter hide the rest.
    await run("graphify", ["export", "obsidian", "--dir", "graphify-out/obsidian"], {
      cwd,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, detail: "code graph canvas at graphify-out/obsidian/graph.canvas" };
  } catch (err) {
    return { ok: false, detail: `graph canvas export skipped (${(err as Error).message.split("\n")[0]})` };
  }
}

export async function exportGraphNotes(cwd: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await run("graphify", ["export", "obsidian", "--dir", "graphify-out/obsidian"], {
      cwd,
      timeout: 120_000,
    });
    return { ok: true, detail: "code graph exported to graphify-out/obsidian/" };
  } catch (err) {
    return { ok: false, detail: `graph note export skipped (${(err as Error).message.split("\n")[0]})` };
  }
}

export function createObsidianMcpServer(ctx: ObsidianToolContext) {
  const { cwd } = ctx;

  const statusTool = tool(
    "obsidian_status",
    "Report whether this project is an Obsidian vault and how many MARVIN-written " +
      "notes it holds (memory facts, backlog items, plans, code-graph notes). " +
      "Read-only. Use it before suggesting the vault to the user, so you state " +
      "what is actually there rather than guessing.",
    {},
    async () => {
      const s = await vaultStatus(cwd);
      const { memory, backlog, plans } = s.notes;
      return textResult(
        (s.isVault
          ? "This project IS an Obsidian vault (`.obsidian/` present)."
          : "This project is NOT yet a vault — no `.obsidian/`. `obsidian_init` creates one.") +
          ` Notes MARVIN maintains here: ${memory} memory fact(s), ${backlog} backlog item(s), ` +
          `${plans} plan(s).` +
          (s.graphNotes ? " Code-graph notes present." : " No code-graph notes yet.") +
          (s.isVault && !s.hiddenFolderPlugin
            ? " WARNING: no hidden-folder plugin is enabled, so Obsidian is not showing " +
              "`.marvin/` at all — the user sees MARVIN.md with broken links and nothing else. " +
              "Tell them to install \"Hidden Folders Access\" and toggle on `.marvin`."
            : ""),
      );
    },
  );

  const initTool = tool(
    "obsidian_init",
    "Turn this project directory into an Obsidian vault, or refresh an existing " +
      "one: writes `.obsidian/` (merging ignore filters, never overwriting the " +
      "user's settings), regenerates the `MARVIN.md` index note, and exports the " +
      "code graph as linked notes. Run it when the user asks to use Obsidian with " +
      "this project. It writes ONLY `.obsidian/app.json`, `MARVIN.md` and " +
      "`graphify-out/obsidian/` — it never touches notes the user wrote.",
    {
      exportGraph: z
        .boolean()
        .optional()
        .describe("Also export the code graph as notes (default true). Needs graphify + an existing graph."),
    },
    async ({ exportGraph }) => {
      const res = await initVault(cwd, basename(cwd));
      if (!res.ok) return errorResult(`Could not set up the vault: ${res.error}`);
      // Regenerate both indexes so the vault is LINKED the moment it opens.
      // They only rewrite on their own next write, so without this the hubs
      // carry pre-ADR-0065 plain paths and the graph view is empty on arrival —
      // the exact failure this integration exists to fix.
      let relinked = 0;
      try { relinked += await rewriteBacklogIndex(cwd); } catch { /* no backlog yet */ }
      try { relinked += await rewriteMemoryIndex(cwd); } catch { /* no memory yet */ }
      // ADR-0091 — plans had no index, so 353 notes on a real project had not
      // one inbound link: invisible to the graph view, backlinks and Dataview.
      let plansLinked = 0;
      try { plansLinked = await rewritePlansIndex(cwd); } catch { /* no plans yet */ }
      relinked += plansLinked;
      // Existing notes predate the derived link trailer, so without this pass
      // the graph stays two starbursts until each item happens to be touched
      // again. Regenerating is safe: the trailer is delimited and recomputed,
      // never merged into the body.
      let itemsLinked = 0;
      try { itemsLinked = await relinkBacklogNotes(cwd); } catch { /* best effort */ }
      const graph = exportGraph === false
        ? { ok: false, detail: "code-graph export skipped (not requested)" }
        : await exportGraphNotes(cwd);
      const { memory, backlog, plans } = res.status.notes;
      return textResult(
        (res.created
          ? "Created the Obsidian vault for this project."
          : "Vault already existed — refreshed it without changing your settings.") +
          (res.ignoreFiltersAdded.length
            ? ` Added ${res.ignoreFiltersAdded.length} ignore filter(s) so the graph view shows notes, not node_modules.`
            : "") +
          ` It now surfaces ${memory} memory fact(s), ${backlog} backlog item(s) and ${plans} plan(s),` +
          ` ${relinked} relinked into the index hubs` +
          (itemsLinked ? `, ${itemsLinked} item note(s) given derived links to their ADRs and files.` : ".") +
          ` ${graph.detail}` +
          (res.status.hiddenFolderPlugin
            ? ""
            : " IMPORTANT: Obsidian does not index dot-prefixed folders, so `.marvin/` is" +
              " invisible until they install the \"Hidden Folders Access\" community plugin" +
              " and toggle on `.marvin`. Say this — without it the vault looks empty.") +
          " Tell the user to open this project directory as a vault in Obsidian, and to start at `MARVIN.md`.",
      );
    },
  );

  return createSdkMcpServer({
    name: "marvin-obsidian",
    version: "1.0.0",
    // ADR-0073 — in the turn-1 prompt, never deferred behind ToolSearch.
    alwaysLoad: true,
    tools: [statusTool, initTool],
  });
}
