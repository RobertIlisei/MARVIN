/**
 * ADR-0118 — measure the fixed context load of a fresh MARVIN tab.
 *
 *   cd sidecar && npx tsx scripts/context-baseline.ts <workDir> [--json]
 *
 * Runs MARVIN's real `runAgent` with the turn-1 system prompt and the posture
 * of the project's most recent session (model, personality, Playwright, mode,
 * thinking), waits for the `runagent.context_baseline` measurement the runtime
 * takes after init, prints it, and aborts before the model does any work.
 * The numbers are the SDK's own token counts (`getContextUsage` in `full`
 * detail), not estimates. Run it before and after a context change.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ContextBaseline } from "@marvin/runtime/context-baseline";
import { slugifyWorkDir } from "@marvin/runtime/projects";
import { runAgent } from "@marvin/runtime/sdk-runner";

import { buildTurnSystemPrompt } from "../src/lib/turn-orchestrator";

interface Posture {
  model?: string;
  personality?: "marvin" | "neutral" | "ultron";
  playwrightEnabled?: boolean;
  thinkingMode?: string;
  mode?: string;
}

/** The posture of the project's newest session, so the probe matches a real tab. */
function latestPosture(workDir: string): Posture {
  const dir = join(process.env.MARVIN_DATA_DIR ?? join(homedir(), ".marvin"), "sessions", slugifyWorkDir(workDir));
  if (!existsSync(dir)) return {};
  const metas = readdirSync(dir)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const m of metas) {
    try {
      const posture = (JSON.parse(readFileSync(m, "utf-8")) as { posture?: Posture }).posture;
      if (posture) return posture;
    } catch {
      /* try the next one */
    }
  }
  return {};
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: npx tsx scripts/context-baseline.ts <workDir> [--json]");
    process.exit(2);
  }
  const workDir = resolve(arg);
  const asJson = process.argv.includes("--json");
  const posture = latestPosture(workDir);
  const personality = posture.personality ?? "marvin";
  process.env.MARVIN_CONTEXT_DETAIL = "full";

  const appendSystemPrompt = await buildTurnSystemPrompt({ workDir, personality, firstMessage: true });
  const abort = new AbortController();
  let baseline: (ContextBaseline & { at: string }) | null = null;

  await runAgent({
    message: "Reply with the single word OK.",
    cwd: workDir,
    workDir,
    model: posture.model ?? "claude-sonnet-5",
    turnId: randomUUID(),
    permissionStrategy: "auto",
    ...(posture.playwrightEnabled !== undefined ? { playwrightEnabled: posture.playwrightEnabled } : {}),
    ...(posture.mode ? { mode: posture.mode as never } : {}),
    ...(posture.thinkingMode ? { thinkingMode: posture.thinkingMode } : {}),
    appendSystemPrompt,
    personality,
    signal: abort.signal,
    onEvent: (ev: SDKMessage) => {
      const e = ev as unknown as { type: string; subtype?: string } & ContextBaseline & { at: string };
      if (e.type === "system" && e.subtype === "marvin.context.baseline") {
        baseline = e;
        abort.abort();
      }
    },
    onConfirmRequest: () => abort.abort(),
  }).catch(() => undefined);

  const b = baseline as (ContextBaseline & { at: string }) | null;
  if (!b) {
    console.error("no baseline measured — the turn ended before init");
    process.exit(1);
  }
  if (asJson) {
    console.log(JSON.stringify({ workDir, posture, appendChars: appendSystemPrompt.length, ...b }, null, 2));
    return;
  }
  const pct = (n: number) => `${((n / b.maxTokens) * 100).toFixed(1)} %`;
  console.log(`${workDir}\nmodel ${b.model} · window ${b.maxTokens.toLocaleString()} · personality ${personality}`);
  console.log(`fixed load ${b.totalTokens.toLocaleString()} tokens = ${pct(b.totalTokens)} of the window\n`);
  for (const c of b.used) console.log(`  ${String(c.tokens.toLocaleString()).padStart(8)}  ${c.name}`);
  const list = (title: string, rows: Array<{ name?: string; path?: string; tokens: number }>) => {
    if (rows.length === 0) return;
    console.log(`\n  ${title}:`);
    for (const r of rows) console.log(`  ${String(r.tokens.toLocaleString()).padStart(8)}  ${r.name ?? r.path}`);
  };
  if (b.autoCompactThreshold) console.log(`\n  auto-compact at ${b.autoCompactThreshold.toLocaleString()} (${pct(b.autoCompactThreshold)})`);
  list("system prompt sections", b.systemPromptSections);
  list("instruction files loaded", b.memoryFiles);
  list("attachments on the messages", b.attachments);
  if (b.skills) console.log(`\n  skills listed: ${b.skills.included} of ${b.skills.total} (${b.skills.tokens.toLocaleString()} tokens)`);
  const servers = Object.entries(b.mcpServers).sort((x, y) => y[1] - x[1]);
  if (servers.length > 0) {
    console.log("\n  loaded MCP tool schemas by server:");
    for (const [name, tokens] of servers) console.log(`  ${String(tokens.toLocaleString()).padStart(8)}  ${name}`);
  }
}

void main();
