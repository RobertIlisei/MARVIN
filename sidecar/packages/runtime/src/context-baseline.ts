/**
 * ADR-0118 — the fixed load a turn starts with, as the SDK measures it.
 *
 * A fresh agri-saas-platform tab sent 142,596 tokens on its first request —
 * 71 % of a 200K window — and died thrashing: compaction frees messages, never
 * the system prompt, tools or skills. This shapes `getContextUsage()` into the
 * record MARVIN logs per turn, so the baseline is a number in the transcript
 * rather than a guess.
 */

/** The transcript `system` event carrying a turn's baseline. The app renders
 *  no system rows, so it is data for the guard and for analysis, not chat. */
export const CONTEXT_BASELINE_SUBTYPE = "marvin.context.baseline";

interface UsageLike {
  categories: ReadonlyArray<{ name: string; tokens: number; kind?: string }>;
  totalTokens: number;
  maxTokens: number;
  model: string;
  mcpTools?: ReadonlyArray<{ serverName: string; tokens: number; isLoaded?: boolean }>;
  autoCompactThreshold?: number;
  memoryFiles?: ReadonlyArray<{ path: string; tokens: number }>;
  systemPromptSections?: ReadonlyArray<{ name: string; tokens: number }>;
  skills?: { totalSkills: number; includedSkills: number; tokens: number };
  messageBreakdown?: { attachmentsByType?: ReadonlyArray<{ name: string; tokens: number }> };
}

export interface ContextBaseline {
  model: string;
  totalTokens: number;
  maxTokens: number;
  /** totalTokens / maxTokens, 0 when the window is unknown. */
  share: number;
  /** Categories occupying the window, largest first. */
  used: Array<{ name: string; tokens: number }>;
  /** Loaded MCP tool-schema tokens per server. */
  mcpServers: Record<string, number>;
  /** Where auto-compaction fires, when the SDK reports it. */
  autoCompactThreshold?: number;
  /** Instruction files the CLI loaded (CLAUDE.md, AGENTS.md, rules, memory). */
  memoryFiles: Array<{ path: string; tokens: number }>;
  systemPromptSections: Array<{ name: string; tokens: number }>;
  skills: { total: number; included: number; tokens: number } | null;
  /** Per-type attachments riding on the messages, largest first. */
  attachments: Array<{ name: string; tokens: number }>;
}

export function contextBaseline(usage: UsageLike): ContextBaseline {
  const used = usage.categories
    .filter((c) => c.kind === "used")
    .map((c) => ({ name: c.name, tokens: c.tokens }))
    .sort((a, b) => b.tokens - a.tokens);
  const mcpServers: Record<string, number> = {};
  for (const t of usage.mcpTools ?? []) {
    if (t.isLoaded === false) continue;
    mcpServers[t.serverName] = (mcpServers[t.serverName] ?? 0) + t.tokens;
  }
  const bySize = (a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens;
  return {
    ...(usage.autoCompactThreshold !== undefined ? { autoCompactThreshold: usage.autoCompactThreshold } : {}),
    memoryFiles: (usage.memoryFiles ?? []).map((f) => ({ path: f.path, tokens: f.tokens })).sort(bySize),
    systemPromptSections: (usage.systemPromptSections ?? []).map((x) => ({ name: x.name, tokens: x.tokens })).sort(bySize),
    skills: usage.skills
      ? { total: usage.skills.totalSkills, included: usage.skills.includedSkills, tokens: usage.skills.tokens }
      : null,
    attachments: (usage.messageBreakdown?.attachmentsByType ?? []).map((x) => ({ name: x.name, tokens: x.tokens })).sort(bySize),
    model: usage.model,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    share: usage.maxTokens > 0 ? usage.totalTokens / usage.maxTokens : 0,
    used,
    mcpServers,
  };
}
