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
import { rewriteBacklogIndex } from "./backlog";
import { rewriteMemoryIndex } from "./memory-mcp";

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
          ` ${relinked} of them relinked into the index hubs.` +
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
    tools: [statusTool, initTool],
  });
}
