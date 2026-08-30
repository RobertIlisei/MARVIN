// advisor-verdict — read what the advisor actually said (ADR-0095).
//
// The gate has only ever observed the advisor *dispatch* (ADR-0094's counter).
// The reply came back as an ordinary tool_result, was read once by the
// executor, and lived nowhere else — so a `reject` discharged the gate exactly
// like a `go`, and caveats survived only as long as the context window. On
// 2026-08-30 a session compacted seven seconds after starting on the advisor's
// fourth caveat; the advice was followed on model diligence alone.
//
// Everything here is deterministic string work — no LLM, no extra turn.
// Pure (ADR-0022) so the parse is test-pinned against real advisor output
// rather than trusted in situ.

import type {
  HookCallback,
  HookJSONOutput,
  PostToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";

import { isSubagentDispatch } from "@marvin/tools/policy";

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { addBacklogItem, MAX_BODY_CHARS } from "./backlog";
import { ADVISOR_SUBAGENT_TYPE, getTurnDesignContext } from "./design-hooks";

/** The verdict line ADR-0033's registered advisor is prompted to end on. */
export type AdvisorVerdict = "go" | "go-with-caveats" | "reject" | "unparsed";

export interface ParsedAdvisorReply {
  verdict: AdvisorVerdict;
  /** One entry per numbered caveat. Empty when the advisor raised none. */
  caveats: string[];
  /** The verdict section verbatim — the fallback body when no caveat parses. */
  verdictText: string;
  /** True when the machine-readable block was used, false when this came from
   *  the prose fallback. Telemetry: a falling structured-rate means the
   *  advisor prompt has drifted and the brittle path is carrying the load. */
  structured: boolean;
}

/** Appended when a caveat body is cut to fit the backlog's body cap. */
export const TRUNCATION_MARKER = "\n\n…[truncated to fit the backlog body cap; full text was in the advisor reply]";

/** Caveats rarely need more than this; a runaway parse is a parse bug. */
export const MAX_CAVEATS = 10;
/** Backlog titles cap at 120 (`MAX_TITLE_CHARS`); leave room for the prefix. */
export const MAX_CAVEAT_TITLE_CHARS = 90;

/** The machine-readable block the registered advisor is required to end on
 *  (ADR-0095 amendment). Parsing model PROSE was the weak link: the shape of
 *  a caveat list is the advisor's stylistic choice, and a regex over it is a
 *  guess that silently degrades. The advisor's system prompt is ours, so the
 *  fix belongs at the source — emit structure, parse structure. The prose
 *  parser below stays as the FALLBACK for a reply that omits the block. */
const VERDICT_BLOCK = /```[^\n]*marvin-verdict[^\n]*\n([\s\S]*?)```/i;

/** Parse the structured block. Returns null when it is absent or unusable, so
 *  the caller can fall back to prose rather than reporting a false `unparsed`. */
export function parseVerdictBlock(reply: string): ParsedAdvisorReply | null {
  const m = VERDICT_BLOCK.exec(reply);
  if (!m?.[1]) return null;
  const body = m[1];
  // Tolerant of the deviations a smaller advisor model actually produces —
  // the tier is the user's pick, so this is a normal case, not an edge one:
  // markdown emphasis around the value, a trailing period, a quoted value.
  const verdictLine =
    /^\s*verdict:\s*["'`*_]*\s*(go-with-caveats|go with caveats|go|reject)\s*["'`*_.]*\s*$/im.exec(body);
  if (!verdictLine?.[1]) return null;
  const verdict = verdictLine[1].toLowerCase().replace(/\s+/g, "-") as AdvisorVerdict;

  // Caveats are one `- ` item per line, under a `caveats:` key. A caveat that
  // wraps onto continuation lines is joined back onto its bullet.
  const caveats: string[] = [];
  let inCaveats = false;
  for (const raw of body.split("\n")) {
    if (/^\s*caveats:\s*$/i.test(raw)) { inCaveats = true; continue; }
    if (!inCaveats) continue;
    if (/^\s*\w[\w-]*:\s*/.test(raw)) break; // next key ends the list
    const item = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*\S)\s*$/.exec(raw);
    if (item?.[1]) caveats.push(item[1].trim());
    else if (raw.trim() && caveats.length) caveats[caveats.length - 1] += ` ${raw.trim()}`;
  }
  return {
    verdict,
    caveats: caveats.slice(0, MAX_CAVEATS),
    verdictText: extractVerdictSection(reply) || body.trim(),
    structured: true,
  };
}

/** Pull the `## Verdict` section out of an advisor reply.
 *
 *  Matched loosely on purpose: the registered prompt asks for
 *  `## Verdict (go / go-with-caveats / reject — one paragraph)`, but the
 *  heading arrives with and without the parenthetical, and occasionally as
 *  `**Verdict**`. Anchoring on the exact heading is how a parser like this
 *  quietly stops matching. */
export function extractVerdictSection(reply: string): string {
  const heading = /^\s*(?:#{1,6}\s*|\*\*)verdict\b[^\n]*$/gim;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  // The advisor's own prompt echoes the heading when it restates its brief, so
  // take the LAST occurrence — the actual verdict, not the instructions.
  while ((m = heading.exec(reply)) !== null) last = m;
  if (!last) return "";
  const rest = reply.slice(last.index + last[0].length);
  // Runs to the next top-level heading, or the end of the reply.
  const next = rest.search(/^\s*#{1,6}\s+\S/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** Classify the verdict. Order matters: "go-with-caveats" contains "go", and
 *  a reject paragraph frequently contains the word "go" in prose. */
export function classifyVerdict(verdictText: string): AdvisorVerdict {
  const t = verdictText.toLowerCase();
  if (!t.trim()) return "unparsed";
  if (/\bgo[-\s]?with[-\s]?caveats?\b/.test(t)) return "go-with-caveats";
  if (/\breject(ed|ing)?\b/.test(t)) return "reject";
  if (/\bgo\b/.test(t)) return "go";
  return "unparsed";
}

/** Split the numbered caveats out of a verdict section.
 *
 *  The registered advisor writes them as `(1) … (2) …` inline, or as a `1.`
 *  list. Both shapes appear in real replies; neither is guaranteed, which is
 *  why `parseAdvisorReply` falls back to the whole section. */
export function extractCaveats(verdictText: string): string[] {
  if (!verdictText.trim()) return [];

  // Shape A — a numbered list, one caveat per line.
  const lines = verdictText.split("\n");
  const listed: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:[-*]\s*)?\(?(\d{1,2})[.)]\s+(.{4,})$/.exec(line);
    if (m?.[2]) listed.push(m[2].trim());
  }
  if (listed.length >= 2) return listed.slice(0, MAX_CAVEATS);

  // Shape B — inline `(1) … (2) …` inside a paragraph. Split on the markers
  // rather than matching each caveat, so the last one isn't truncated by a
  // lookahead that needs a following marker.
  const parts = verdictText.split(/\((\d{1,2})\)\s+/);
  if (parts.length >= 5) {
    const out: string[] = [];
    // parts = [prefix, "1", text, "2", text, …]
    for (let i = 2; i < parts.length; i += 2) {
      const text = parts[i]?.trim();
      if (text && text.length >= 4) out.push(stripTrailingProse(text));
    }
    if (out.length >= 2) return out.slice(0, MAX_CAVEATS);
  }

  return listed.slice(0, MAX_CAVEATS);
}

/** Trim a caveat at the sentence that closes the enumeration, so the last item
 *  doesn't swallow the advisor's closing remarks. */
function stripTrailingProse(text: string): string {
  const cut = text.search(/\.\s+(?:[A-Z][a-z]+\s+){0,3}(?:But|However|Overall|Otherwise)\b/);
  return (cut === -1 ? text : text.slice(0, cut + 1)).trim();
}

/** Condense a caveat to a backlog title — one actionable line. */
export function caveatTitle(caveat: string): string {
  const flat = caveat.replace(/\s+/g, " ").trim();
  // Prefer the first sentence; a caveat's first clause is the ask, the rest is
  // justification that belongs in the body.
  const firstSentence = /^(.{20,}?[.;])\s/.exec(flat)?.[1] ?? flat;
  const base = firstSentence.length <= MAX_CAVEAT_TITLE_CHARS
    ? firstSentence
    : `${firstSentence.slice(0, MAX_CAVEAT_TITLE_CHARS - 1).trimEnd()}…`;
  return base.replace(/[.;]$/, "");
}

export function parseAdvisorReply(reply: string): ParsedAdvisorReply {
  // Structure first, prose second. A reply carrying the block is parsed
  // deterministically; one without it falls back to the regex parser, which is
  // what every advisor reply written before this amendment looks like.
  const structured = parseVerdictBlock(reply);
  if (structured) return structured;
  const verdictText = extractVerdictSection(reply);
  const verdict = classifyVerdict(verdictText);
  const caveats = extractCaveats(verdictText);
  return { verdict, caveats, verdictText, structured: false };
}

/** Flatten an `Agent` tool result into text.
 *
 *  The SDK hands back `{ content: [{ type: "text", text }] }` for a subagent,
 *  but plain strings and `{ content: "…" }` both occur; a parser that assumes
 *  one shape silently returns "" for the others. */
export function toolResponseText(response: unknown): string {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  const r = response as Record<string, unknown>;
  const content = r.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && typeof (b as Record<string, unknown>).text === "string") {
          return (b as Record<string, unknown>).text as string;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof r.text === "string") return r.text;
  return "";
}


/** True when this dispatch is an advisor consult — the same two routes
 *  ADR-0094 taught the counter to recognise. */
export function isAdvisorDispatch(toolName: string, toolInput: unknown): boolean {
  if (!isSubagentDispatch(toolName)) return false;
  const input = (toolInput ?? {}) as Record<string, unknown>;
  const type = typeof input.subagent_type === "string" ? input.subagent_type : "";
  const description = typeof input.description === "string" ? input.description : "";
  return (
    type.trim().toLowerCase() === ADVISOR_SUBAGENT_TYPE ||
    description.trim().toLowerCase().startsWith("advisor:")
  );
}

/** Where advice lands when the backlog refuses it. A plain append-only file
 *  with no validation, no caps and no index to rebuild — the point is that it
 *  cannot fail for the same reasons the backlog can. */
export function advisorFallbackPath(workDir: string): string {
  return join(workDir, ".marvin", "advisor-caveats.md");
}

/** Last-resort sink. Called only when a backlog write was refused or threw. */
async function writeFallback(
  workDir: string,
  topic: string,
  entries: { title: string; body: string }[],
  reason: string,
): Promise<boolean> {
  try {
    const path = advisorFallbackPath(workDir);
    await mkdir(dirname(path), { recursive: true });
    const stamp = new Date().toISOString();
    const lines = [
      `## ${stamp} — advisor caveats on ${topic}`,
      `_Not parked to the backlog: ${reason}_`,
      "",
      ...entries.map((e) => `- **${e.title}** — ${e.body}`),
      "",
    ];
    await appendFile(path, `${lines.join("\n")}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

export interface ParkOutcome {
  /** Backlog ids successfully parked. */
  parked: string[];
  /** Human-readable reasons for each item that did NOT reach the backlog. */
  failures: string[];
  /** True when the fallback file caught what the backlog refused. */
  fellBack: boolean;
}

/** Park each advisor caveat as a provisional backlog item (ADR-0047: un-gated
 *  at discovery, keep/dismiss at the scope-met handoff).
 *
 *  Every refusal path is surfaced, never swallowed. `addBacklogItem` returns
 *  `{ok:false}` for the open-item cap and for validation, and those are NOT
 *  exceptions — an earlier version dropped them silently, which made the
 *  200-item cap a quiet destroyer of advisor advice. */
async function parkCaveats(args: {
  workDir: string;
  caveats: string[];
  verdictText: string;
  marvinSessionId: string;
  topic: string;
}): Promise<ParkOutcome> {
  const { workDir, caveats, verdictText, marvinSessionId, topic } = args;
  // Fail toward keeping too much: an unparsed verdict is parked whole rather
  // than dropped. A lost caveat is the failure this ADR exists to prevent.
  const entries = caveats.length
    ? caveats.map((c) => ({ title: caveatTitle(c), body: c }))
    : [{ title: `Advisor caveats on ${topic}`, body: verdictText }];

  const parked: string[] = [];
  const failures: string[] = [];
  const unparked: { title: string; body: string }[] = [];

  for (const entry of entries) {
    // The body cap is a hard limit in the backlog store. Truncating HERE, with
    // a marker, is the difference between a shortened item and a refused one —
    // and the fallback path (a whole verdict section) is exactly the shape
    // most likely to exceed it.
    const suffix = `\n\n_Raised by the advisor (ADR-0095) on: ${topic}._`;
    const room = MAX_BODY_CHARS - suffix.length - TRUNCATION_MARKER.length;
    const body =
      entry.body.length > room
        ? `${entry.body.slice(0, room)}${TRUNCATION_MARKER}${suffix}`
        : `${entry.body}${suffix}`;

    let result: Awaited<ReturnType<typeof addBacklogItem>>;
    try {
      result = await addBacklogItem(workDir, {
        title: entry.title,
        body,
        kind: "investigate",
        severity: "med",
        sessionId: marvinSessionId,
        provisional: true,
      });
    } catch (err) {
      // The reason matters. Discarding it left `parked: 0` in telemetry with
      // nothing to act on.
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    if (result.ok) parked.push(result.item.id);
    else {
      failures.push(`${entry.title}: ${result.error}`);
      unparked.push(entry);
    }
  }

  const fellBack = unparked.length > 0 && (await writeFallback(workDir, topic, unparked, failures.join("; ")));
  return { parked, failures, fellBack };
}

/**
 * PostToolUse hook — read the advisor's verdict, persist its caveats (ADR-0095).
 *
 * `additionalContext` rather than `updatedToolOutput`: the advisor's own words
 * ARE the payload here, so they are appended to, never replaced. The governor
 * replaces because there the content is the problem — the opposite case.
 */
export function makeAdvisorVerdictPostToolUse(args: {
  workDir: string;
  marvinSessionId: string;
  turnId: string;
  /** The advisor's resolved model. Recorded beside `structured` so the
   *  block-compliance rate is readable PER MODEL — the advisor tier is the
   *  user's pick from the Settings picker, not fixed, so a Haiku-tier advisor
   *  half-following the format and a drifted prompt would otherwise be the
   *  same number. */
  advisorModel?: string;
}): HookCallback {
  const { workDir, marvinSessionId, turnId, advisorModel } = args;
  return async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {} as HookJSONOutput;
    const evt = input as PostToolUseHookInput;
    if (!isAdvisorDispatch(evt.tool_name, evt.tool_input)) return {} as HookJSONOutput;

    const reply = toolResponseText(evt.tool_response);
    const parsed = parseAdvisorReply(reply);

    const ctx = getTurnDesignContext(turnId);
    if (ctx) ctx.advisorVerdict = parsed.verdict;

    // Nothing to say when the advisor's reply had no verdict at all — the
    // executor still reads the full text, and inventing a summary of an
    // unparsed reply would be worse than silence.
    if (parsed.verdict === "unparsed") {
      logAdvisorVerdict({
        turnId,
        advisorModel,
        verdict: parsed.verdict,
        structured: false,
        caveats: 0,
        parked: 0,
      });
      return {} as HookJSONOutput;
    }

    const topic =
      (typeof (evt.tool_input as Record<string, unknown> | undefined)?.description === "string"
        ? ((evt.tool_input as Record<string, unknown>).description as string)
        : ""
      ).replace(/^advisor:\s*/i, "").trim() || "an advisor consult";

    let outcome: ParkOutcome = { parked: [], failures: [], fellBack: false };
    if (parsed.verdict !== "go") {
      outcome = await parkCaveats({
        workDir,
        caveats: parsed.caveats,
        verdictText: parsed.verdictText,
        marvinSessionId,
        topic,
      });
    }

    logAdvisorVerdict({
      turnId,
      advisorModel,
      verdict: parsed.verdict,
      structured: parsed.structured,
      caveats: parsed.caveats.length,
      parked: outcome.parked.length,
      // The REASON, not just the count. Without this a failed park was a zero
      // in telemetry with nothing to act on.
      failures: outcome.failures,
      fellBack: outcome.fellBack,
    });

    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: advisorContextLine(parsed.verdict, outcome),
      },
    } as HookJSONOutput;
  };
}

/** The one line appended to the advisor's result. */
export function advisorContextLine(verdict: AdvisorVerdict, outcome: ParkOutcome): string {
  const head = `[advisor verdict — ${verdict}]`;
  if (verdict === "go") {
    return `${head} No caveats raised. Proceed, and cite the advisor's substantive input in your reply.`;
  }
  const { parked, failures, fellBack } = outcome;
  const parts: string[] = [];
  if (parked.length) {
    parts.push(
      `${parked.length} caveat(s) parked to the backlog as ${parked.join(", ")} — they come back at the scope-met keep/dismiss review, so they survive a compaction.`,
    );
  }
  if (failures.length) {
    // Name the reason. "Could not be parked" with no cause is not actionable.
    parts.push(
      `${failures.length} caveat(s) were REFUSED by the backlog (${failures.join("; ")})` +
        (fellBack
          ? ` and were appended to .marvin/advisor-caveats.md instead — tell the user, they are outside the review flow.`
          : ` and could NOT be written anywhere. They exist ONLY in this context window: act on them in this turn or restate them to the user now.`),
    );
  }
  const captured = parts.join(" ") || "No caveats to persist.";
  if (verdict === "reject") {
    return `${head} The advisor rejected this. ${captured} Your next mutation of a trigger path will be blocked once so the verdict is read, then it proceeds — the decision is the user's, not the advisor's. State plainly whether you are overriding, and why.`;
  }
  return `${head} ${captured}`;
}

function logAdvisorVerdict(fields: {
  turnId: string;
  advisorModel?: string;
  verdict: AdvisorVerdict;
  structured?: boolean;
  caveats: number;
  parked: number;
  failures?: string[];
  fellBack?: boolean;
}): void {
  // Same channel as the design hooks and the governor — grep `advisor.verdict`.
  console.log(
    `[marvin.telemetry] ${JSON.stringify({
      kind: "advisor.verdict",
      ...fields,
      at: new Date().toISOString(),
    })}`,
  );
}
