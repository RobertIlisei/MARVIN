/**
 * Dispatching the supervisor (ADR-0127 §2) — one bounded SDK turn per wake.
 *
 * Runtime-dispatched like the ADR-0059 auditor: never an executor subagent,
 * never on an executor's agents map. Containment is belt and braces:
 *
 *   1. `disallowedTools` refuses every mutator, the web, TodoWrite and every
 *      subagent-dispatch spelling before the model sees them;
 *   2. one decision function, applied twice — as `canUseTool` (for what the SDK
 *      asks about) and as a PreToolUse hook (for Read / Grep / Glob, which the
 *      SDK auto-allows WITHOUT consulting `canUseTool`, `sdk-runner.ts`). It is
 *      a closed set: the read tools minus secret paths and the supervisor's own
 *      directory, the graph, and `marvin-supervise` only from the in-process
 *      server. Everything else is refused, ToolSearch included — which is why
 *      both servers load up front.
 *
 * The SDK session is resumed across wakes and rotated when the context passes
 * 22.5 % of the model's window (measured) or the day turns; every rotation is ledgered.
 * Rotation costs money, never correctness: a rotated message wake's packet
 * carries the last 20 conversation messages (ADR-0128 §6).
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { type CanUseTool, type HookCallback, type HookJSONOutput, type Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { createGraphMcpServer } from "@marvin/graphify-bridge";
import { isSecretFileName } from "@marvin/tools/fs-constants";
import { SUBAGENT_DISPATCH_TOOLS } from "@marvin/tools/policy";

import { buildSubprocessEnv } from "./auth";
import { contextWindowFor, ensureProviderModelId } from "./models";
import { resolveRoleModel } from "./role-models";
import { appendLedgerEntry, readLedger, supervisorRoot } from "./supervisor-ledger";
import { createSupervisorMcpServer, SUPERVISE_SERVER_NAME, type VerbContext } from "./supervisor-mcp";
import { getUserMessage, listMessages, MAX_IMAGES_PER_WAKE, readAttachment } from "./supervisor-messages";
import { renderWakePacket, SUPERVISOR_SYSTEM_PROMPT, type WakeItem } from "./supervisor-prompt";
import { getSupervisorState, pauseSupervisorForFault, updateSupervisorRuntime } from "./supervisor-state";
import { type TurnContentBlock, TurnInputChannel } from "./turn-input";

/** Consecutive provenance refusals in one wake before the supervisor pauses itself and escalates. */
export const PROVENANCE_REFUSALS_BEFORE_PAUSE = 3;

export const SUPERVISOR_DISALLOWED_TOOLS: readonly string[] = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  // Derived from the one definition (ADR-0088): a copy is how ADR-0079 happened.
  ...SUBAGENT_DISPATCH_TOOLS,
  "TodoWrite",
];

/**
 * Past this share of the model's window the next wake starts a fresh session
 * from the packet and the ledger (ADR-0128 §6). Measured in plan milestone
 * [7.1] on ten real conversation wakes: a fresh session's wake ends at
 * 35–39K tokens and costs $0.07–0.08; resumed wakes grew 4–6K tokens each and
 * cost $0.18 at 52K, $0.33 at 63K and $0.60 at 81K. Resuming never beat a
 * fresh session past the first resume, so rotate just above a fresh
 * session's context: 45K on a 200K window, not the 40 % first planned.
 */
export const ROTATE_AT_WINDOW_FRACTION = 0.225;
export const rotateAtTokens = (window: number): number => Math.round(window * ROTATE_AT_WINDOW_FRACTION);
/** The threshold on the default 200K window. */
export const ROTATE_AT_INPUT_TOKENS = rotateAtTokens(200_000);
/** Conversation messages a rotated (or first) session's message packet carries. */
export const ROTATED_CONVERSATION_MESSAGES = 20;

const SUPERVISE_PREFIX = `mcp__${SUPERVISE_SERVER_NAME}__`;
const GRAPH_PREFIX = "mcp__marvin-graph__";
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/**
 * The graph verbs that only read. `graph_save_result`, `graph_reflect`,
 * `graph_export_callflow` and `graph_index_schema` write under `graphify-out/`
 * (the last also takes an env-var name from the model): the supervisor writes
 * no file, so they are refused.
 */
export const SUPERVISOR_GRAPH_READ_TOOLS: ReadonlySet<string> = new Set([
  "graph_summary",
  "graph_search",
  "graph_neighbors",
  "graph_path",
  "graph_query",
  "graph_explain",
  "graph_affected",
  "graph_change_impact",
  "graph_community",
  "graph_god_nodes",
  "graph_diagnose",
]);

/**
 * A path or glob that names a secret file. The patterns are `fs-constants.ts`'s
 * (REVIEW.md: secret lists live there only); a glob segment is tested with its
 * wildcards stripped, so `.env*`, `**\/.env.local`, `*.pem` and `id_rsa*` match.
 */
function namesSecret(value: string): boolean {
  return value
    .split(/[\\/]/)
    .some((seg) => seg && (isSecretFileName(seg) || isSecretFileName(seg.replace(/[*?[\]{}]/g, ""))));
}

function real(p: string): string {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
}

/** The non-glob prefix of a pattern: `src/**\/*.ts` → `src`. */
function globBase(pattern: string): string {
  const i = pattern.search(/[*?[{]/);
  const head = i < 0 ? pattern : pattern.slice(0, i);
  return head.endsWith("/") || i < 0 ? head : path.dirname(head);
}

/** Why a read must not happen, or null. Paths resolve against the project root and must stay inside it. */
function readRefusal(toolName: string, input: Record<string, unknown>, workDir: string): string | null {
  const root = real(path.resolve(workDir));
  const supDir = supervisorRoot();
  const targets: string[] = [];
  const patterns: string[] = [];
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (toolName === "Read") {
    const fp = str(input.file_path);
    if (fp) targets.push(fp);
  } else if (toolName === "Grep") {
    targets.push(str(input.path) ?? ".");
    const g = str(input.glob);
    if (g) patterns.push(g);
  } else {
    const base = str(input.path) ?? ".";
    const pat = str(input.pattern);
    if (pat) {
      patterns.push(pat);
      targets.push(path.isAbsolute(pat) ? globBase(pat) || "/" : path.join(base, globBase(pat)));
    } else {
      targets.push(base);
    }
  }
  for (const p of patterns) if (namesSecret(p)) return "the supervisor does not read secret files (.env, keys, certificates)";
  for (const t of targets) {
    const abs = path.resolve(root, t);
    const resolved = real(abs);
    if (namesSecret(abs) || namesSecret(resolved)) return "the supervisor does not read secret files (.env, keys, certificates)";
    if (abs.startsWith(supDir) || resolved.startsWith(supDir)) return "the supervisor does not read its own data directory";
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return "the supervisor reads only inside the project";
  }
  return null;
}

export type SupervisorToolDecision = { allow: true } | { allow: false; reason: string; provenance?: true };

/** The supervisor's closed tool set. One function, so the hook and `canUseTool` cannot disagree. */
export function supervisorToolDecision(
  toolName: string,
  input: Record<string, unknown>,
  workDir: string,
  mcpServer?: { name: string; source: string },
): SupervisorToolDecision {
  if (SUPERVISOR_DISALLOWED_TOOLS.includes(toolName)) {
    return { allow: false, reason: `${toolName} is not in the supervisor's tool set — it has no write tools (ADR-0127 §2)` };
  }
  if (READ_TOOLS.has(toolName)) {
    const refusal = readRefusal(toolName, input, workDir);
    return refusal ? { allow: false, reason: refusal } : { allow: true };
  }
  if (toolName.startsWith(GRAPH_PREFIX)) {
    if (!SUPERVISOR_GRAPH_READ_TOOLS.has(toolName.slice(GRAPH_PREFIX.length))) {
      return { allow: false, reason: `${toolName} writes under graphify-out/; the supervisor writes no file` };
    }
    return mcpServer && mcpServer.source !== "sdk"
      ? { allow: false, reason: `a non-in-process server named like marvin-graph (source "${mcpServer.source}")`, provenance: true }
      : { allow: true };
  }
  if (toolName.startsWith(SUPERVISE_PREFIX)) {
    // ADR-0117: the name is a convention; `source: "sdk"` is a fact only the host makes true.
    return mcpServer?.source === "sdk" && mcpServer.name === SUPERVISE_SERVER_NAME
      ? { allow: true }
      : {
          allow: false,
          reason: `marvin-supervise is admitted only from the in-process server (got ${mcpServer ? `source "${mcpServer.source}"` : "no provenance"})`,
          provenance: true,
        };
  }
  return { allow: false, reason: `${toolName} is not in the supervisor's tool set` };
}

export function makeSupervisorCanUseTool(opts: { workDir: string; onProvenanceRefusal?: (toolName: string, reason: string) => void }): CanUseTool {
  return async (toolName, input, cbOpts) => {
    const d = supervisorToolDecision(toolName, input, opts.workDir, (cbOpts as { mcpServer?: { name: string; source: string } }).mcpServer);
    if (d.allow) return { behavior: "allow", updatedInput: input };
    if (d.provenance) opts.onProvenanceRefusal?.(toolName, d.reason);
    return { behavior: "deny", message: d.reason };
  };
}

/** Read / Grep / Glob never reach `canUseTool`; this hook gives them the same decision. */
export function makeSupervisorPreToolUseHook(workDir: string): HookCallback {
  return async (input) => {
    const evt = input as { tool_name?: string; tool_input?: unknown };
    const toolInput = evt.tool_input && typeof evt.tool_input === "object" ? (evt.tool_input as Record<string, unknown>) : {};
    const name = String(evt.tool_name ?? "");
    // MCP provenance is not on the hook input; `canUseTool` checks it for the MCP tools.
    if (name.startsWith("mcp__")) return {};
    const d = supervisorToolDecision(name, toolInput, workDir);
    if (d.allow) return {};
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason },
    } as HookJSONOutput;
  };
}

export interface SupervisorQueryArgs {
  projectId: string;
  workDir: string;
  prompt: string;
  resume: string | null;
  model: string | undefined;
  verbCtx: VerbContext;
  abortController?: AbortController;
  onProvenanceRefusal?: (toolName: string, reason: string) => void;
}

export function buildSupervisorQueryOptions(args: SupervisorQueryArgs): { prompt: string; options: Options } {
  const caps = getSupervisorState(args.projectId).caps;
  return {
    prompt: args.prompt,
    options: {
      cwd: args.workDir,
      // The capability token is never in a turn's environment (§5); this env carries only auth.
      env: { ...buildSubprocessEnv(), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      settingSources: [],
      ...(args.model ? { model: args.model } : {}),
      ...(args.resume ? { resume: args.resume } : {}),
      ...(args.abortController ? { abortController: args.abortController } : {}),
      disallowedTools: [...SUPERVISOR_DISALLOWED_TOOLS],
      mcpServers: {
        [SUPERVISE_SERVER_NAME]: createSupervisorMcpServer(args.verbCtx),
        "marvin-graph": createGraphMcpServer(args.workDir),
      },
      canUseTool: makeSupervisorCanUseTool({
        workDir: args.workDir,
        ...(args.onProvenanceRefusal ? { onProvenanceRefusal: args.onProvenanceRefusal } : {}),
      }),
      hooks: { PreToolUse: [{ hooks: [makeSupervisorPreToolUseHook(args.workDir)] }] },
      systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
      maxTurns: caps.maxTurnsPerWake,
      includePartialMessages: false,
    },
  };
}

export interface WakeDeps {
  query: typeof sdkQuery;
  resolveModel: () => Promise<string | undefined>;
  /** The model's window, for the rotation threshold. Absent: the default 200K. */
  contextWindow?: (model: string | undefined) => Promise<number>;
}

const defaultWakeDeps: WakeDeps = {
  contextWindow: (model) => contextWindowFor(model ?? null),
  query: sdkQuery,
  resolveModel: async () =>
    ensureProviderModelId(await resolveRoleModel("supervisor").then((r) => (r === "inherit" ? null : r))) ?? undefined,
};

export interface WakeResult {
  ok: boolean;
  costUsd?: number;
  sdkSessionId?: string;
  error?: string;
}

const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

/**
 * ADR-0129 — the images of this wake's own messages, oldest first, up to the
 * per-wake cap. Only the wake's messages: a rotated session's history is text.
 */
export function collectWakeImages(projectId: string, items: readonly WakeItem[]): { blocks: TurnContentBlock[]; notes: Record<string, { attached: number; omitted: number }>; bytes: number } {
  const blocks: TurnContentBlock[] = [];
  const notes: Record<string, { attached: number; omitted: number }> = {};
  let bytes = 0;
  for (const it of items) {
    if (it.trigger !== "message" || !it.message) continue;
    const atts = getUserMessage(projectId, it.message.id)?.attachments ?? [];
    if (!atts.length) continue;
    const note = { attached: 0, omitted: 0 };
    for (const a of atts) {
      const data = blocks.length < MAX_IMAGES_PER_WAKE ? readAttachment(projectId, a) : null;
      if (!data) {
        note.omitted += 1;
        continue;
      }
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data: data.toString("base64") } });
      bytes += data.length;
      note.attached += 1;
    }
    notes[it.message.id] = note;
  }
  return { blocks, notes, bytes };
}

/** One wake: a bounded turn over the packet. Never throws; a failure is ledgered and reported. */
export async function runSupervisorWake(
  args: { projectId: string; workDir: string; items: WakeItem[]; verbCtx: VerbContext; abortController?: AbortController },
  deps: WakeDeps = defaultWakeDeps,
): Promise<WakeResult> {
  const { projectId } = args;
  const st = getSupervisorState(projectId);
  const today = new Date().toISOString().slice(0, 10);
  const model = await deps.resolveModel().catch(() => undefined);
  const rotateAt = deps.contextWindow ? rotateAtTokens(await deps.contextWindow(model).catch(() => 200_000)) : ROTATE_AT_INPUT_TOKENS;
  const stale = !!st.sdkSessionId && (st.lastInputTokens > rotateAt || dayOf(st.sdkSessionStartedAt) !== today);
  const fresh = !st.sdkSessionId || stale;
  const wakeId = args.verbCtx.wakeId;

  if (stale) {
    appendLedgerEntry(projectId, {
      kind: "rotation",
      verb: "rotate",
      tab: null,
      wakeId,
      mode: st.mode,
      reason: st.lastInputTokens > rotateAt ? `context ${st.lastInputTokens} tokens > ${rotateAt}` : "a new day",
    });
  }
  const images = collectWakeImages(projectId, args.items);
  const imageSummary = images.blocks.length ? `, ${images.blocks.length} image${images.blocks.length === 1 ? "" : "s"} (${Math.round(images.bytes / 1024)} KB)` : "";
  appendLedgerEntry(projectId, {
    kind: "wake",
    verb: "start",
    tab: null,
    wakeId,
    mode: st.mode,
    reason: `${args.items.length} item(s)${imageSummary}${model ? ` · ${model}` : ""}`,
    ...(model ? { model } : {}),
  });

  // A conversation wake's spend is counted apart from watching (ADR-0128 §7) — one cap still stops both.
  const conversation = args.items.some((i) => i.trigger === "message");
  const prompt = renderWakePacket({
    items: args.items,
    charter: st.charter,
    freshSession: fresh,
    autonomy: st.autonomy,
    ...(fresh ? { ledgerTail: readLedger(projectId, { limit: 50 }) } : {}),
    // Correctness never rests on the session's memory: a new session re-reads the conversation.
    ...(fresh && conversation ? { conversation: listMessages(projectId, { limit: ROTATED_CONVERSATION_MESSAGES }) } : {}),
    ...(Object.keys(images.notes).length ? { imageNotes: images.notes } : {}),
  });
  // Images need the streaming form: one user message, the packet then the images. The channel closes on the result.
  const channel = images.blocks.length ? new TurnInputChannel() : null;
  const sdkPrompt = channel ? channel.stream([{ type: "text", text: prompt }, ...images.blocks]) : prompt;

  let sessionId: string | undefined;
  let costUsd = 0;
  let inputTokens = st.lastInputTokens;
  const abortController = args.abortController ?? new AbortController();
  let provenanceRefusals = 0;
  // A denied marvin-supervise call is a fault, not a policy outcome: ledger
  // each one, and after a few in a row stop burning turns — pause and escalate.
  const onProvenanceRefusal = (toolName: string, reason: string) => {
    provenanceRefusals += 1;
    appendLedgerEntry(projectId, { kind: "verb", verb: toolName, tab: null, wakeId, mode: st.mode, decision: "refuse", reason: `provenance: ${reason}` });
    if (provenanceRefusals === PROVENANCE_REFUSALS_BEFORE_PAUSE) {
      pauseSupervisorForFault(projectId, `marvin-supervise was refused for provenance ${provenanceRefusals} times in one wake`);
      abortController.abort();
    }
  };
  try {
    const { options } = buildSupervisorQueryOptions({
      projectId,
      workDir: args.workDir,
      prompt,
      resume: fresh ? null : st.sdkSessionId,
      model,
      verbCtx: args.verbCtx,
      abortController,
      onProvenanceRefusal,
    });
    const contextOf = (u: Record<string, unknown>) => {
      const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    };
    // The context the session ends at is the LAST model call's input. The result's usage sums every
    // call of the wake (measured 2026-10-31: 97K reported for a ~33K context), which would rotate every wake.
    let lastCallContext = 0;
    for await (const ev of deps.query({ prompt: sdkPrompt, options })) {
      const e = ev as { type?: string; subtype?: string; session_id?: unknown; total_cost_usd?: unknown; usage?: Record<string, unknown>; message?: { usage?: Record<string, unknown> } };
      if (typeof e.session_id === "string") sessionId = e.session_id;
      if (e.type === "assistant" && e.message?.usage) lastCallContext = contextOf(e.message.usage) || lastCallContext;
      if (e.type === "result") {
        channel?.close();
        if (typeof e.total_cost_usd === "number") costUsd = e.total_cost_usd;
        inputTokens = lastCallContext || contextOf(e.usage ?? {});
        if (e.subtype && e.subtype !== "success") throw new Error(`supervisor turn ended: ${e.subtype}`);
      }
    }
  } catch (err) {
    channel?.close();
    const error = (err as Error).message || String(err);
    updateSupervisorRuntime(projectId, { addSpendUsd: costUsd, spendKind: conversation ? "conversation" : "watching" });
    appendLedgerEntry(projectId, { kind: "wake", verb: "end", tab: null, wakeId, mode: st.mode, reason: `failed: ${error}`, costUsd });
    return { ok: false, error, costUsd };
  }

  updateSupervisorRuntime(projectId, {
    ...(sessionId ? { sdkSessionId: sessionId } : {}),
    ...(fresh ? { sdkSessionStartedAt: new Date().toISOString() } : {}),
    lastInputTokens: inputTokens,
    addSpendUsd: costUsd,
    spendKind: conversation ? "conversation" : "watching",
  });
  appendLedgerEntry(projectId, { kind: "wake", verb: "end", tab: null, wakeId, mode: st.mode, reason: "done", costUsd });
  return { ok: true, costUsd, ...(sessionId ? { sdkSessionId: sessionId } : {}) };
}
