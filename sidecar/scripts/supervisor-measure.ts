/**
 * Measure real supervisor conversation wakes (ADR-0128 §6–§7, plan [7.1]).
 *
 *   cd sidecar && npx tsx scripts/supervisor-measure.ts <workDir> [n=10]
 *
 * Runs n user messages through the real loop, dispatch and model, one at a
 * time, in a throwaway MARVIN_DATA_DIR (the user's real supervisor state is
 * never touched), against <workDir> read-only. Prints, per wake: cost, the
 * context it ended at (input + cache tokens), whether it rotated, whether it
 * replied, and how long it took. Spends real money — about the cost of n
 * supervisor turns.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workDir = path.resolve(process.argv[2] ?? process.cwd());
const n = Number(process.argv[3] ?? 10);

const MESSAGES = [
  "Hi. Which tabs are you watching right now, and is anything waiting for me?",
  "In one paragraph: what does ADR-0128 change about how I talk to you?",
  "Is there anything in docs/plans/supervisor.md about how often your session rotates? Quote the line.",
  "Could you open a tab to tidy the supervisor guide's wording? Don't do it yet, just tell me what you'd propose.",
  "What would you need from me before you could merge a tab for me?",
  "Approve the merge of fix-flags.",
  "Which file holds your tool allow-list? Give me the path and the function name.",
  "Summarise your ledger for today in two lines.",
  "If I said 'yes, push it' right now, what would you do?",
  "Thanks — anything you think I should look at before I stop for the day?",
];

async function main(): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "marvin-sup-measure-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  const { addProject } = await import("@marvin/runtime/projects");
  const { applySupervisorAction, bootSupervisor, currentSupervisorToken, getSupervisorState } = await import("@marvin/runtime/supervisor-state");
  const { defaultLoopDeps, SupervisorLoop } = await import("@marvin/runtime/supervisor-loop");
  const { addUserMessage, listMessages } = await import("@marvin/runtime/supervisor-messages");
  const { readLedger } = await import("@marvin/runtime/supervisor-ledger");
  const { getAnthropicAuth } = await import("@marvin/runtime/auth");

  console.log(`auth: ${(getAnthropicAuth() as { mode: string }).mode} · workDir: ${workDir} · wakes: ${n}`);
  bootSupervisor();
  const projectId = addProject({ name: "measure", workDir }).id;
  const r = applySupervisorAction({ projectId, action: "start", charter: "Keep the supervisor work honest: no act without a ground.", capUsd: 50 }, currentSupervisorToken());
  if (!r.ok) throw new Error(`start failed: ${JSON.stringify(r)}`);
  const loop = new SupervisorLoop(defaultLoopDeps());
  loop.start();

  const rows: Array<Record<string, unknown>> = [];
  try {
    for (let i = 0; i < n; i++) {
      const before = getSupervisorState(projectId).lastWake?.wakeId ?? null;
      const rotationsBefore = readLedger(projectId).filter((e) => e.kind === "rotation").length;
      const t0 = Date.now();
      const m = addUserMessage(projectId, MESSAGES[i % MESSAGES.length] as string);
      loop.noteUserMessage(projectId, m.id);
      while ((getSupervisorState(projectId).lastWake?.wakeId ?? null) === before) {
        if (Date.now() - t0 > 6 * 60_000) throw new Error(`wake ${i + 1} did not finish in 6 min`);
        await new Promise((d) => setTimeout(d, 500));
      }
      const st = getSupervisorState(projectId);
      const end = readLedger(projectId).filter((e) => e.kind === "wake" && e.verb === "end").at(-1);
      const replied = listMessages(projectId).some((x) => x.from === "supervisor" && x.origin?.kind === "message" && x.origin.messageIds.includes(m.id));
      const row = {
        wake: i + 1,
        outcome: st.lastWake?.outcome,
        costUsd: Number((end?.costUsd ?? 0).toFixed(4)),
        contextTokens: st.lastInputTokens,
        rotated: readLedger(projectId).filter((e) => e.kind === "rotation").length > rotationsBefore,
        replied,
        seconds: Math.round((Date.now() - t0) / 1000),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    loop.stop();
    const st = getSupervisorState(projectId);
    const costs = rows.map((r) => Number(r.costUsd));
    const ctx = rows.map((r) => Number(r.contextTokens));
    const sum = costs.reduce((a, b) => a + b, 0);
    console.log(
      JSON.stringify(
        {
          wakes: rows.length,
          totalUsd: Number(sum.toFixed(4)),
          meanUsd: Number((sum / Math.max(1, rows.length)).toFixed(4)),
          maxUsd: Math.max(0, ...costs),
          contextFirst: ctx[0] ?? null,
          contextLast: ctx.at(-1) ?? null,
          contextGrowthPerWake: rows.length > 1 ? Math.round(((ctx.at(-1) ?? 0) - (ctx[0] ?? 0)) / (rows.length - 1)) : null,
          spend: st.spend,
        },
        null,
        1,
      ),
    );
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
