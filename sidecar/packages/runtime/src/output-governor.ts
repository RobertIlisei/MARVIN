/**
 * Output governor — bound what a Bash result costs BEFORE the model sees it.
 *
 * ## The problem it closes
 *
 * A tool result enters the context whole. The `claude` binary does persist
 * oversized output to disk and hand the model a pointer instead — but its
 * threshold is ~655 KB, so a 15.7K-char Spring Boot log and a 4.8K-char
 * surefire dump sailed into a real session untouched (measured 2026-08-29:
 * tool results were the single largest bucket of a 101K-token transcript,
 * and one Bash result alone was 3.9K tokens of Hikari shutdown noise). Those
 * bytes are then re-sent on every subsequent request until compaction, and
 * compaction itself then has to summarise them.
 *
 * ## The mechanism
 *
 * A `PostToolUse` hook. The SDK lets a hook return `updatedToolOutput`, which
 * *replaces the tool output before it is sent to the model* — the same
 * plumbing the design hooks already use on the `PreToolUse` side. For a Bash
 * result over `GOVERN_MAX_CHARS`, the model gets the HEAD (where a build
 * announces its failure) and the TAIL (where it announces its result), an
 * elision marker with the exact size of what was cut, and the path of the
 * full output on disk. Nothing is lost: it Reads or greps the file if the
 * middle turns out to matter, which is exactly what the CLI's own persisted
 * output asks of it.
 *
 * ## Bash only, deliberately
 *
 * `Read` results are also big, but the model asked for that file and already
 * has `offset` / `limit` to page it; governing the middle of a file it chose
 * to read second-guesses a deliberate act. Bash output is the case where the
 * model has no way to ask for less. Extend to other tools only with a
 * measured reason.
 *
 * `MARVIN_OUTPUT_GOVERNOR=off` disables it (same switch shape as the design
 * hooks' `MARVIN_DESIGN_HOOKS`).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  HookCallback,
  HookJSONOutput,
  PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { getMarvinDataDir } from "./paths";

/** Results at or under this many chars pass through untouched (~1.5K tokens). */
export const GOVERN_MAX_CHARS = 6000;
/** Kept from the start — first error, first stack frame, the command echo. */
export const GOVERN_HEAD_CHARS = 2500;
/** Kept from the end — the summary line, the exit status, the last error. */
export const GOVERN_TAIL_CHARS = 2500;

export interface GovernResult {
  text: string;
  elided: boolean;
  elidedChars: number;
  elidedLines: number;
}

/**
 * Head + tail of `text` with an elision marker, or `text` unchanged when it
 * fits. Cuts land on line boundaries so the model never sees half a line
 * pretending to be a whole one. Pure — exported for tests.
 */
export function governText(text: string, savedTo: string | null): GovernResult {
  if (text.length <= GOVERN_MAX_CHARS) {
    return { text, elided: false, elidedChars: 0, elidedLines: 0 };
  }
  // Head: back up to the last newline inside the budget.
  let headEnd = text.lastIndexOf("\n", GOVERN_HEAD_CHARS);
  if (headEnd <= 0) headEnd = GOVERN_HEAD_CHARS;
  // Tail: forward to the first newline after the budget boundary.
  let tailStart = text.indexOf("\n", text.length - GOVERN_TAIL_CHARS);
  if (tailStart < 0 || tailStart <= headEnd) tailStart = text.length - GOVERN_TAIL_CHARS;
  tailStart += 1;

  const middle = text.slice(headEnd, tailStart);
  const elidedLines = (middle.match(/\n/g) ?? []).length;
  const where = savedTo
    ? `Full output: ${savedTo} — Read or grep it ONLY if the elided part matters.`
    : "Full output could not be saved to disk; re-run with a narrower command if the elided part matters.";
  const marker =
    `\n\n[MARVIN output governor: ${elidedLines} lines (${middle.length} chars) elided ` +
    `from the middle of this output. ${where}]\n\n`;
  return {
    text: text.slice(0, headEnd) + marker + text.slice(tailStart),
    elided: true,
    elidedChars: middle.length,
    elidedLines,
  };
}

/** Where a governed result's full text lands. */
function outputPath(marvinSessionId: string, toolUseId: string): string {
  return join(getMarvinDataDir(), "tool-output", marvinSessionId, `${toolUseId}.txt`);
}

/**
 * Persist the full output so the pointer in the marker is real. Best-effort:
 * a failed write must not fail the tool call — the marker then says so and
 * the model still has head + tail.
 */
function persistFullOutput(
  marvinSessionId: string,
  toolUseId: string,
  stdout: string,
  stderr: string,
): string | null {
  try {
    const path = outputPath(marvinSessionId, toolUseId);
    mkdirSync(join(getMarvinDataDir(), "tool-output", marvinSessionId), { recursive: true });
    const body = stderr
      ? `=== stdout ===\n${stdout}\n\n=== stderr ===\n${stderr}\n`
      : stdout;
    writeFileSync(path, body, { encoding: "utf-8", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

export function makeOutputGovernorPostToolUse(args: {
  marvinSessionId: string;
  turnId: string;
}): HookCallback {
  const { marvinSessionId, turnId } = args;
  const enabled = (process.env.MARVIN_OUTPUT_GOVERNOR ?? "enforce").toLowerCase() !== "off";
  return async (input, toolUseId) => {
    if (!enabled || input.hook_event_name !== "PostToolUse") return {} as HookJSONOutput;
    const evt = input as PostToolUseHookInput;
    if (evt.tool_name !== "Bash") return {} as HookJSONOutput;
    const resp = evt.tool_response;
    if (!resp || typeof resp !== "object" || Array.isArray(resp)) return {} as HookJSONOutput;
    const r = resp as Record<string, unknown>;
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    if (stdout.length <= GOVERN_MAX_CHARS && stderr.length <= GOVERN_MAX_CHARS) {
      return {} as HookJSONOutput;
    }

    const id = toolUseId ?? evt.tool_use_id ?? randomUUID();
    const saved = persistFullOutput(marvinSessionId, id, stdout, stderr);
    const out = governText(stdout, saved);
    const err = governText(stderr, saved);

    // Same channel as the design hooks — grep `output.governed` in the
    // sidecar log to see what the governor is actually cutting.
    console.log(
      `[marvin.telemetry] ${JSON.stringify({
        kind: "output.governed",
        turnId,
        toolUseId: id,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        elidedChars: out.elidedChars + err.elidedChars,
        savedTo: saved,
        at: new Date().toISOString(),
      })}`,
    );

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedToolOutput: { ...r, stdout: out.text, stderr: err.text },
      },
    } as HookJSONOutput;
  };
}
