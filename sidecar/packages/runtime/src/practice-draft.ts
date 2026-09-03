/**
 * Phase 4 (ADR-0105) — a model drafts the rule message, on request.
 *
 * The runner never calls a model. This does, and only when the user clicks
 * "Draft message" in the pane. It sees AGGREGATES — the finding's kind,
 * counts, rate, cost, its last few detail lines, the current message, and
 * the head of the project's CLAUDE.md — never a transcript. The dispatch is
 * the session auditor's (ADR-0059): a fresh read-only SDK session with every
 * mutating tool disallowed and no MCP servers, two turns at most. The draft
 * is returned to the pane; nothing is persisted until the user accepts it
 * through the existing approve / edit-message paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildSubprocessEnv } from "./auth";
import { ensureProviderModelId, latestForTier } from "./models";
import { COST_UNITS, POLARITY } from "./practice-extractors";
import { readLedger, readRules, RULE_TEMPLATES } from "./practice";
import { getProject } from "./projects";
import { AUDITOR_DISALLOWED_TOOLS } from "./session-auditor";

export const DRAFT_DISALLOWED_TOOLS: readonly string[] = [...AUDITOR_DISALLOWED_TOOLS, "Read", "Grep", "Glob", "LSP"];

export interface DraftPacket {
  findingId: string;
  kind: string;
  unit: string;
  distinctSessions: number;
  rate: number | null;
  costTotal: number;
  value: number;
  details: string[];
  currentMessage: string | null;
  claudeMdHead: string;
}

export interface DraftResult {
  ok: boolean;
  error?: string;
  message?: string;
  rationale?: string;
  costUsd?: number;
  packet?: DraftPacket;
}

export const DRAFT_SYSTEM_PROMPT = [
  "You write ONE rule message for MARVIN, an AI pair-programming assistant, from measured evidence.",
  "The message is read by the model at the moment the rule fires. It must name the remedy — the exact",
  "tool call, skill, or step to take — in one or two sentences, and may cite the measurement in one clause.",
  "No preamble, no headings. Then, on a new line starting with `Rationale:`, one sentence on why this",
  "wording. Output exactly:",
  "",
  "Message: <the message, at most 600 characters>",
  "Rationale: <one sentence>",
].join("\n");

const CLAUDE_MD_CAP = 6 * 1024;

export function buildDraftPacket(projectId: string, findingId: string): DraftPacket | null {
  const f = readLedger(projectId).findings[findingId];
  if (!f || POLARITY[f.kind] !== "failure") return null;
  const rule = readRules().find((r) => r.fingerprint === f.id && r.status === "active");
  const template = RULE_TEMPLATES[f.kind];
  const details = Object.values(f.sessions)
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
    .slice(0, 3)
    .map((s) => s.detail);
  let claudeMdHead = "";
  const workDir = getProject(projectId)?.workDir;
  if (workDir) {
    const p = join(workDir, "CLAUDE.md");
    if (existsSync(p)) {
      try {
        claudeMdHead = readFileSync(p, "utf-8").slice(0, CLAUDE_MD_CAP);
      } catch {
        /* optional */
      }
    }
  }
  return {
    findingId: f.id,
    kind: f.kind,
    unit: COST_UNITS[f.kind],
    distinctSessions: f.distinctSessions,
    rate: f.rate,
    costTotal: f.costTotal,
    value: f.value,
    details,
    currentMessage: rule?.message ?? template?.message ?? null,
    claudeMdHead,
  };
}

export function renderDraftPrompt(p: DraftPacket): string {
  const lines = [
    `Finding: ${p.findingId} (kind ${p.kind})`,
    `Seen in ${p.distinctSessions} distinct sessions; ${p.rate === null ? "no paired success" : `${Math.round(p.rate * 100)}% of the time`}; ` +
      `total cost ${Math.round(p.costTotal)} ${p.unit}; value ${p.value.toFixed(2)}.`,
    "Latest occurrences:",
    ...p.details.map((d) => `- ${d}`),
    p.currentMessage ? `Current message:\n${p.currentMessage}` : "No current message (report-only kind).",
  ];
  if (p.claudeMdHead) lines.push("", "Project instructions (head of CLAUDE.md):", "```", p.claudeMdHead, "```");
  return lines.join("\n");
}

/** Tolerant parse of the two-line output. */
export function parseDraft(text: string): { message: string; rationale: string } | null {
  const m = /Message:\s*([\s\S]*?)(?:\n\s*Rationale:\s*([\s\S]*))?$/i.exec(text.trim());
  if (!m || !m[1]?.trim()) return null;
  return { message: m[1].trim().slice(0, 1200), rationale: (m[2] ?? "").trim().slice(0, 400) };
}

export type DraftDispatch = (prompt: string) => Promise<{ text: string; costUsd?: number }>;

async function defaultDispatch(prompt: string, cwd: string, model?: string): Promise<{ text: string; costUsd?: number }> {
  const finalModel = ensureProviderModelId(model ?? (await latestForTier("sonnet"))) ?? undefined;
  const q = query({
    prompt,
    options: {
      cwd,
      env: buildSubprocessEnv(),
      ...(finalModel ? { model: finalModel } : {}),
      disallowedTools: [...DRAFT_DISALLOWED_TOOLS],
      mcpServers: {},
      systemPrompt: DRAFT_SYSTEM_PROMPT,
      maxTurns: 2,
      includePartialMessages: false,
    },
  });
  let text = "";
  let costUsd: number | undefined;
  for await (const ev of q) {
    if (ev.type === "assistant") {
      const content = (ev as { message?: { content?: unknown } }).message?.content;
      if (Array.isArray(content)) {
        const parts: string[] = [];
        for (const block of content) {
          const b = block as { type?: string; text?: unknown };
          if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
        }
        if (parts.length > 0) text = parts.join("\n");
      }
    } else if (ev.type === "result" && "total_cost_usd" in ev && typeof ev.total_cost_usd === "number") {
      costUsd = ev.total_cost_usd;
    }
  }
  return { text, costUsd };
}

export async function draftPracticeMessage(args: {
  projectId: string;
  findingId: string;
  model?: string;
  /** Test seam. */
  dispatch?: DraftDispatch;
}): Promise<DraftResult> {
  const packet = buildDraftPacket(args.projectId, args.findingId);
  if (!packet) return { ok: false, error: "unknown finding, or a success kind (nothing to draft)" };
  const cwd = getProject(args.projectId)?.workDir ?? process.cwd();
  const dispatch = args.dispatch ?? ((prompt: string) => defaultDispatch(prompt, cwd, args.model));
  let out: { text: string; costUsd?: number };
  try {
    out = await dispatch(renderDraftPrompt(packet));
  } catch (e) {
    return { ok: false, error: `draft session error: ${(e as Error).message}`, packet };
  }
  const parsed = parseDraft(out.text);
  if (!parsed) return { ok: false, error: "the model did not return a Message: / Rationale: pair", packet };
  return { ok: true, message: parsed.message, rationale: parsed.rationale, ...(out.costUsd !== undefined ? { costUsd: out.costUsd } : {}), packet };
}
