import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advisorContextLine,
  advisorFallbackPath,
  parseVerdictBlock,
  caveatTitle,
  classifyVerdict,
  extractCaveats,
  extractVerdictSection,
  isAdvisorDispatch,
  makeAdvisorVerdictPostToolUse,
  parseAdvisorReply,
  toolResponseText,
} from "../src/advisor-verdict";
import { listBacklog, MAX_BODY_CHARS } from "../src/backlog";
import { clearTurnDesignContext, createTurnDesignContext } from "../src/design-hooks";

// ADR-0095 — the gate used to observe only the advisor DISPATCH, so `reject`
// discharged it exactly like `go` and caveats lived only as long as the context
// window. These tests pin the parse against a REAL advisor reply captured from
// the 2026-08-30 incident (session 711b8605, a prod platform_audit migration) —
// the same discipline BenignCancellation's fixture failure taught: assert
// against the artifact the system actually produces, never one we invented.
const FIXTURE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "fixtures", "advisor-reply-go-with-caveats.md"),
  "utf-8",
);

describe("advisor-verdict · parsing a real reply", () => {
  it("reads the verdict and all four caveats from the captured incident reply", () => {
    const parsed = parseAdvisorReply(FIXTURE);
    expect(parsed.verdict).toBe("go-with-caveats");
    expect(parsed.caveats).toHaveLength(4);
    // The four asks, in order, as the advisor actually wrote them.
    expect(parsed.caveats[0]).toContain("quantify");
    expect(parsed.caveats[1]).toContain("tripwire");
    expect(parsed.caveats[2]).toContain("spot-check");
    expect(parsed.caveats[3]).toContain("amend ADR-0363");
  });

  it("takes the LAST Verdict heading, so an echoed brief doesn't win", () => {
    const reply = [
      "You asked me to end on ## Verdict (go|go-with-caveats|reject).",
      "",
      "## Verdict",
      "",
      "**Reject.** The migration drops a column with no backfill.",
    ].join("\n");
    expect(classifyVerdict(extractVerdictSection(reply))).toBe("reject");
  });

  it("stops the verdict section at the next heading", () => {
    const section = extractVerdictSection(
      ["## Verdict", "", "**Go.** Looks right.", "", "## Appendix", "", "Notes here."].join("\n"),
    );
    expect(section).toContain("Looks right");
    expect(section).not.toContain("Notes here");
  });
});

describe("advisor-verdict · classification", () => {
  it("does not read go-with-caveats as a plain go", () => {
    expect(classifyVerdict("**Go-with-caveats.** Ship it, but…")).toBe("go-with-caveats");
    expect(classifyVerdict("Go with caveats — see below")).toBe("go-with-caveats");
  });

  it("does not read a reject paragraph as a go just because it says 'go'", () => {
    expect(classifyVerdict("**Reject.** Do not let this go to prod.")).toBe("reject");
  });

  it("returns unparsed for a reply with no verdict at all", () => {
    expect(classifyVerdict("")).toBe("unparsed");
    expect(parseAdvisorReply("Some prose with no heading.").verdict).toBe("unparsed");
  });

  it("reads a plain go", () => {
    expect(classifyVerdict("**Go.** No concerns.")).toBe("go");
  });
});

describe("advisor-verdict · caveat extraction", () => {
  it("handles a numbered list as well as the inline (1) … (2) shape", () => {
    const listed = extractCaveats(
      ["**Go-with-caveats.**", "", "1. Add a rollback path.", "2. Pin the schema version."].join("\n"),
    );
    expect(listed).toHaveLength(2);
    expect(listed[0]).toBe("Add a rollback path.");
  });

  it("keeps the last inline caveat instead of truncating it", () => {
    const caveats = extractCaveats("Go-with-caveats. But: (1) add a test, and (2) amend the ADR.");
    expect(caveats).toHaveLength(2);
    expect(caveats[1]).toContain("amend the ADR");
  });

  it("condenses a caveat into a one-line title", () => {
    const title = caveatTitle(
      "quantify and document the ~1-day audit-write gap (this is the compliance-relevant part, not the 500)",
    );
    expect(title.length).toBeLessThanOrEqual(91);
    expect(title).toContain("quantify");
  });
});

describe("advisor-verdict · tool-result shapes", () => {
  it("flattens every shape a subagent result arrives in", () => {
    expect(toolResponseText("plain")).toBe("plain");
    expect(toolResponseText({ content: "string content" })).toBe("string content");
    expect(toolResponseText({ content: [{ type: "text", text: "block" }] })).toBe("block");
    expect(toolResponseText({ text: "bare text" })).toBe("bare text");
    expect(toolResponseText(null)).toBe("");
  });
});

describe("advisor-verdict · dispatch detection", () => {
  it("recognises both ADR-0094 routes and nothing else", () => {
    expect(isAdvisorDispatch("Agent", { subagent_type: "advisor", description: "review it" })).toBe(true);
    expect(isAdvisorDispatch("Agent", { subagent_type: "general-purpose", description: "advisor: review" })).toBe(true);
    expect(isAdvisorDispatch("Agent", { subagent_type: "scout", description: "scout: find ids" })).toBe(false);
    expect(isAdvisorDispatch("Bash", { subagent_type: "advisor" })).toBe(false);
  });
});

describe("advisor-verdict · PostToolUse hook", () => {
  let workDir: string;
  const turnId = "test-turn-advisor-verdict";

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "marvin-advisor-"));
  });
  afterEach(async () => {
    clearTurnDesignContext(turnId);
    await rm(workDir, { recursive: true, force: true });
  });

  const hook = () =>
    makeAdvisorVerdictPostToolUse({ workDir, marvinSessionId: "sess-1", turnId });

  const event = (reply: string, input: Record<string, unknown> = { subagent_type: "advisor", description: "advisor: the migration" }) =>
    ({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: input,
      tool_response: { content: [{ type: "text", text: reply }] },
    }) as never;

  it("parks every caveat from the real reply as a provisional backlog item", async () => {
    const ctx = createTurnDesignContext(turnId, workDir);
    const out = (await hook()(event(FIXTURE), undefined as never, {} as never)) as Record<string, never>;

    const items = await listBacklog(workDir);
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.status === "provisional")).toBe(true);
    expect(ctx.advisorVerdict).toBe("go-with-caveats");

    const context = (out.hookSpecificOutput as unknown as { additionalContext: string }).additionalContext;
    expect(context).toContain("go-with-caveats");
    expect(context).toContain("scope-met");

    // The caveat body keeps the advisor's own words, not just the title.
    const first = items[0];
    expect(first).toBeDefined();
    const body = await readFile(join(workDir, ".marvin", "backlog", `${first!.id}.md`), "utf-8");
    expect(body).toContain("advisor");
  });

  it("records a reject and says the next write will be blocked once", async () => {
    const ctx = createTurnDesignContext(turnId, workDir);
    const reply = "## Verdict\n\n**Reject.** The guard is per-table, not per-grantee.";
    const out = (await hook()(event(reply), undefined as never, {} as never)) as Record<string, never>;
    expect(ctx.advisorVerdict).toBe("reject");
    const context = (out.hookSpecificOutput as unknown as { additionalContext: string }).additionalContext;
    expect(context).toContain("rejected");
    expect(context).toContain("blocked once");
  });

  it("parks the verdict verbatim when no caveat parses, rather than dropping it", async () => {
    createTurnDesignContext(turnId, workDir);
    const reply = "## Verdict\n\n**Go-with-caveats.** Be careful about the rollout window.";
    await hook()(event(reply), undefined as never, {} as never);
    const items = await listBacklog(workDir);
    expect(items).toHaveLength(1);
    const only = items[0];
    expect(only).toBeDefined();
    const body = await readFile(join(workDir, ".marvin", "backlog", `${only!.id}.md`), "utf-8");
    expect(body).toContain("rollout window");
  });

  it("parks nothing on a clean go", async () => {
    const ctx = createTurnDesignContext(turnId, workDir);
    await hook()(event("## Verdict\n\n**Go.** No concerns."), undefined as never, {} as never);
    expect(ctx.advisorVerdict).toBe("go");
    expect(await listBacklog(workDir)).toHaveLength(0);
  });

  it("ignores a non-advisor subagent result entirely", async () => {
    createTurnDesignContext(turnId, workDir);
    const out = await hook()(
      event(FIXTURE, { subagent_type: "scout", description: "scout: enumerate ids" }),
      undefined as never,
      {} as never,
    );
    expect(out).toEqual({});
    expect(await listBacklog(workDir)).toHaveLength(0);
  });

  it("stays silent when the reply has no verdict", async () => {
    const ctx = createTurnDesignContext(turnId, workDir);
    const out = await hook()(event("Just some prose."), undefined as never, {} as never);
    expect(out).toEqual({});
    expect(ctx.advisorVerdict).toBe("unparsed");
    expect(await listBacklog(workDir)).toHaveLength(0);
  });
});

describe("advisor-verdict · the line appended to the result", () => {
  it("warns loudly when caveats could not be persisted", () => {
    const line = advisorContextLine("go-with-caveats", {
      parked: [],
      failures: ["quantify the gap: backlog already has 200 open items"],
      fellBack: false,
    });
    // The REASON must survive to the model — "could not be parked" alone is
    // not actionable.
    expect(line).toContain("200 open items");
    expect(line).toContain("ONLY in this context window");
  });

  it("names the fallback file when the backlog refused but disk caught it", () => {
    const line = advisorContextLine("go-with-caveats", {
      parked: [],
      failures: ["x: cap reached"],
      fellBack: true,
    });
    expect(line).toContain(".marvin/advisor-caveats.md");
    expect(line).toContain("outside the review flow");
  });
});


describe("advisor-verdict · the structured block (ADR-0095 amendment)", () => {
  // Parsing model prose was the weak link: the shape of a caveat list is the
  // advisor's stylistic choice. The advisor's system prompt is ours, so the
  // contract moved to a block it emits.
  const blockReply = [
    "## Verdict",
    "",
    "**Go-with-caveats.** Ship it, but mind the rollout.",
    "",
    "```marvin-verdict",
    "verdict: go-with-caveats",
    "caveats:",
    "- Quantify the audit-write gap before closing the incident",
    "- Add a deploy-time tripwire for platform_audit access",
    "```",
  ].join("\n");

  it("prefers the block over the prose, and says which path ran", () => {
    const parsed = parseAdvisorReply(blockReply);
    expect(parsed.structured).toBe(true);
    expect(parsed.verdict).toBe("go-with-caveats");
    expect(parsed.caveats).toEqual([
      "Quantify the audit-write gap before closing the incident",
      "Add a deploy-time tripwire for platform_audit access",
    ]);
  });

  it("joins a caveat that wraps onto a continuation line", () => {
    const parsed = parseVerdictBlock(
      ["```marvin-verdict", "verdict: reject", "caveats:", "- first caveat that", "  wraps onto a second line", "```"].join("\n"),
    );
    expect(parsed?.caveats).toEqual(["first caveat that wraps onto a second line"]);
  });

  // The advisor tier is the USER'S pick from the Settings model picker, not
  // fixed at Opus — so a smaller model that half-follows the format is a
  // normal case. The block parser tolerates what they actually emit.
  it("tolerates the deviations a smaller advisor model produces", () => {
    const sloppy = [
      "```marvin-verdict",
      "verdict: **Reject**.",
      "caveats:",
      "* first, with a star bullet",
      "1. second, numbered",
      "```",
    ].join("\n");
    const parsed = parseVerdictBlock(sloppy);
    expect(parsed?.verdict).toBe("reject");
    expect(parsed?.caveats).toEqual(["first, with a star bullet", "second, numbered"]);
  });

  it("accepts `go with caveats` spelled with spaces", () => {
    expect(parseVerdictBlock("```marvin-verdict\nverdict: go with caveats\n```")?.verdict).toBe(
      "go-with-caveats",
    );
  });

  it("falls back to prose when the block is absent — every pre-amendment reply", () => {
    const parsed = parseAdvisorReply(FIXTURE);
    expect(parsed.structured).toBe(false);
    expect(parsed.caveats).toHaveLength(4);
  });

  it("falls back to prose when the block is present but malformed", () => {
    const malformed = FIXTURE + "\n\n```marvin-verdict\nnothing parseable here\n```";
    const parsed = parseAdvisorReply(malformed);
    // Must NOT report `unparsed` just because the block was unusable.
    expect(parsed.verdict).toBe("go-with-caveats");
    expect(parsed.structured).toBe(false);
  });
});

describe("advisor-verdict · nothing is lost silently", () => {
  let workDir: string;
  const turnId = "test-turn-advisor-loss";

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "marvin-advisor-loss-"));
  });
  afterEach(async () => {
    clearTurnDesignContext(turnId);
    await rm(workDir, { recursive: true, force: true });
  });

  it("truncates an oversized caveat body instead of letting the backlog refuse it", async () => {
    createTurnDesignContext(turnId, workDir);
    // The fallback path parks a whole verdict SECTION — the shape most likely
    // to exceed the body cap, which would have lost the entire verdict.
    const huge = "x".repeat(MAX_BODY_CHARS * 2);
    const reply = `## Verdict\n\n**Go-with-caveats.** ${huge}`;
    const hook = makeAdvisorVerdictPostToolUse({ workDir, marvinSessionId: "s", turnId });
    await hook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "advisor", description: "advisor: big" },
        tool_response: { content: [{ type: "text", text: reply }] },
      } as never,
      undefined as never,
      {} as never,
    );
    const items = await listBacklog(workDir);
    expect(items).toHaveLength(1);
    const body = await readFile(join(workDir, ".marvin", "backlog", `${items[0]!.id}.md`), "utf-8");
    expect(body).toContain("truncated to fit");
  });

  it("writes the fallback file when the backlog cannot take the item", async () => {
    createTurnDesignContext(turnId, workDir);
    // A read-only backlog directory makes every addBacklogItem fail the way a
    // real disk problem would.
    await mkdir(join(workDir, ".marvin"), { recursive: true });
    await writeFile(join(workDir, ".marvin", "backlog"), "not a directory", "utf-8");

    const hook = makeAdvisorVerdictPostToolUse({ workDir, marvinSessionId: "s", turnId });
    const out = (await hook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        tool_input: { subagent_type: "advisor", description: "advisor: the migration" },
        tool_response: { content: [{ type: "text", text: FIXTURE }] },
      } as never,
      undefined as never,
      {} as never,
    )) as Record<string, never>;

    // The advice reached disk despite the backlog being unusable.
    const fallback = await readFile(advisorFallbackPath(workDir), "utf-8");
    expect(fallback).toContain("quantify");
    const context = (out.hookSpecificOutput as unknown as { additionalContext: string }).additionalContext;
    expect(context).toContain("REFUSED");
    expect(context).toContain("advisor-caveats.md");
  });
});
