/**
 * marvin-backlog — in-process MCP server for the project backlog (ADR-0044).
 *
 * The model write path for `.marvin/backlog/`. Like `marvin-memory`, the value
 * is the ENFORCED boundary: `backlog_add` rejects payloads that belong elsewhere
 * (durable facts → `remember`, status → git, decisions → ADR) and caps length,
 * so the backlog can't bloat into a project journal (the ADR-0042 lesson). The
 * file logic lives in the shared `backlog.ts` store — the `/api/backlog` routes
 * (macOS UI) write through the same code.
 *
 * A PARKING LOT, not a dispatch queue (Golden Rule 1): these tools record and
 * resolve items for the single assistant + the user. Nothing here pulls work or
 * runs autonomously. Scoped to the active project's workDir.
 */

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  addBacklogItem,
  BACKLOG_KINDS,
  BACKLOG_TYPE_ALIASES,
  type BacklogItem,
  type BacklogSeverity,
  claimBacklogItem,
  classifyBacklogText,
  describeClaim,
  listBacklog,
  listResolved,
  MAX_BODY_CHARS,
  MAX_NOTES_CHARS,
  MAX_TITLE_CHARS,
  parseSeverity,
  resolveBacklogItem,
  setBacklogStatus,
  updateBacklogItem,
} from "./backlog";
import { deriveBacklogFromGit } from "./backlog-derive";
import { groomBacklog, renderGroomReport } from "./backlog-groom";
import { notifyTabsOfResolution } from "./backlog-notify";

export interface BacklogToolContext {
  cwd: string;
  /** Best-effort link back to the parking session; absent for non-chat callers. */
  marvinSessionId?: string | undefined;
  /** ADR-0113 — the tab's branch when it has its own worktree; names the claim. */
  branch?: string | undefined;
  /** ADR-0113 §3 — with a project, a resolution is announced to the tabs it touches. */
  projectId?: string | undefined;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

/**
 * Render overlap candidates for the model to relay.
 *
 * Deliberately phrased as a question for the USER, not an instruction to the
 * model: overlap is a hint, and acting on it unprompted would resolve work
 * nobody agreed to drop (ADR-0044 addendum).
 */
function overlapNote(related: BacklogItem[], lead: string): string {
  if (related.length === 0) return "";
  const list = related.map((i) => `\`${i.id}\` "${i.title}" [${i.status}]`).join(", ");
  return (
    ` ${lead} ${related.length === 1 ? "1 live item looks" : `${related.length} live items look`}` +
    ` like the same work: ${list}. Mention this to the user and let THEM decide` +
    ` whether to merge or resolve — do not resolve or rewrite them yourself.`
  );
}

export function createBacklogMcpServer(ctx: BacklogToolContext) {
  const { cwd, marvinSessionId, branch, projectId } = ctx;

  const addTool = tool(
    "backlog_add",
    "Park an ACTIONABLE deferred-work item to the project backlog — a follow-up, " +
      "an out-of-scope improvement, or a blocker you noticed in flight but won't " +
      "do now. AUTO-CAPTURE AT DISCOVERY (ADR-0047): the moment you notice such " +
      "an item — even mid-task, unrelated to what you're doing — call this with " +
      "`provisional: true` IMMEDIATELY (no user go-ahead needed); it parks as " +
      "provisional and you batch keep/dismiss it at the scope-met handoff. Do NOT " +
      "wait for the handoff to capture — that loses items. Omit `provisional` " +
      "(or pass false) only for an item the user has explicitly confirmed. NOT " +
      "for durable facts (→ remember), verification/commit status (→ git), or " +
      "decisions (→ ADR) — those are rejected. A parking lot the user revisits, " +
      "never an auto-executed queue. When YOU later fix an item, end the commit " +
      "message with the trailer `Backlog: <slug>` (one line per item): the item " +
      "resolves itself, with the commit as evidence, once that commit is on the " +
      "project's branch. An item whose notes are full takes no more: file the next " +
      "point as a new item with `relatesTo: <slug>`.",
    {
      title: z.string().min(1).describe(`One actionable line; the dedup key (≤${MAX_TITLE_CHARS} chars).`),
      force: z
        .boolean()
        .optional()
        .describe(
          "Only after a capture was refused as a near-duplicate: set true if the item really IS distinct despite the similar wording. Never set it pre-emptively.",
        ),
      body: z.string().optional().describe(`Optional: why it matters + the concrete change (≤${MAX_BODY_CHARS} chars).`),
      severity: z.string().optional().describe("low | medium | high — exactly these. Default medium. Anything else is refused. (`priority` is accepted as another name for it.)"),
      priority: z.string().optional().describe("Alias of `severity`; same three values."),
      type: z
        .enum(Object.keys(BACKLOG_TYPE_ALIASES) as [string, ...string[]])
        .optional()
        .describe("Alias of `kind`, not a second field: bug → bug, chore → chore, debt → chore, idea → feature. `kind` wins when both are given."),
      release: z.string().optional().describe('Free text: the release it was found in or is aimed at, e.g. "v3.2".'),
      origin: z.string().optional().describe("Where it came from: a session id or a review name."),
      waitsOn: z
        .string()
        .optional()
        .describe("Alias of `blockedOn` (and marks the item blocked): owner, authority, reviewer, another item's slug, or one line."),
      relatesTo: z
        .string()
        .optional()
        .describe("Slug of an existing item this one follows up — use it when that item's notes are full and cannot take more."),
      kind: z
        .enum(BACKLOG_KINDS)
        .optional()
        .describe(
          "What SORT of work: bug | feature | investigate | test | docs | chore. " +
            "SET THIS ON EVERY CAPTURE — you already judge severity, which is harder, " +
            "and you have the context for why you parked it. `investigate` is for items " +
            "whose output is a DECISION rather than a diff (verify / model / recheck). " +
            "Use `unspecified` ONLY when the item genuinely spans kinds; a best-guess " +
            "kind is one click for the user to correct, whereas an unclassified backlog " +
            "makes the filters useless (ADR-0064 addendum).",
        ),
      blocked: z
        .boolean()
        .optional()
        .describe(
          "True when the item waits on something OUTSIDE the repo — a sign-off, a " +
            "legal cutoff, a third party. Not a status: a blocked item is still open, " +
            "it just isn't pickable. Always pair with `blockedOn`.",
        ),
      blockedOn: z
        .string()
        .optional()
        .describe("What unblocks it, one line. Required in practice whenever blocked is true."),
      provisional: z
        .boolean()
        .optional()
        .describe("true = auto-capture at discovery (no go-ahead); awaits keep/dismiss at the handoff. Default false (user-confirmed)."),
    },
    async ({ title, body, severity, priority, type, release, origin, waitsOn, relatesTo, kind, blocked, blockedOn, provisional, force }) => {
      let parsed: BacklogSeverity | undefined;
      if (severity !== undefined || priority !== undefined) {
        const p = parseSeverity(severity ?? priority);
        if (!p.ok) return errorResult(p.error);
        parsed = p.value;
      }
      const cls = classifyBacklogText(title, body ?? "");
      if (!cls.ok) {
        return errorResult(
          `Rejected — this isn't an actionable backlog item (${cls.why}). The backlog ` +
            `holds deferred WORK; record facts via \`remember\`, status in git, and ` +
            `decisions in an ADR (ADR-0044).`,
        );
      }
      const res = await addBacklogItem(cwd, {
        title,
        ...(force ? { force } : {}),
        ...(body ? { body } : {}),
        ...(parsed ? { severity: parsed } : {}),
        ...(kind ? { kind } : {}),
        ...(type ? { type: type as keyof typeof BACKLOG_TYPE_ALIASES } : {}),
        ...(release !== undefined ? { release } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(waitsOn !== undefined ? { waitsOn } : {}),
        ...(relatesTo ? { relatesTo } : {}),
        ...(blocked !== undefined ? { blocked } : {}),
        ...(blockedOn ? { blockedOn } : {}),
        ...(provisional ? { provisional } : {}),
        ...(marvinSessionId ? { sessionId: marvinSessionId } : {}),
      });
      if (!res.ok) return errorResult(res.error);
      if (res.duplicateOf) {
        if (res.duplicateHeldBy) {
          return textResult(
            `NOT parked — this is already being worked: \`${res.duplicateOf}\` ` +
              `("${res.item.title}") is \`doing\`, held by ${res.duplicateHeldBy}. ` +
              `Do NOT fix it here as well: tell the user another tab holds it, and let them decide whether to ` +
              `switch to that tab or continue. If it is genuinely different work, call \`backlog_add\` again with \`force: true\`.`,
          );
        }
        return textResult(
          `NOT parked — this restates an item already open: \`${res.duplicateOf}\` ` +
            `("${res.item.title}"). Nothing was lost; that item still stands. ` +
            `If your note adds something, update THAT item's body instead of parking a ` +
            `second one. If it is genuinely different work, call \`backlog_add\` again ` +
            `with \`force: true\` and say why in the body.`,
        );
      }
      const prov = res.item.status === "provisional";
      return textResult(
        `${res.created ? "Parked" : "Updated"} backlog item \`${res.item.id}\` ` +
          `(${res.item.severity}${prov ? ", provisional" : ""}). ` +
          (prov
            ? `Auto-captured — list it at the handoff and keep/dismiss with \`backlog_resolve\`.`
            : `Surfaces next session and in the backlog panel; resolve with \`backlog_resolve\`.`) +
          (res.created && res.item.kind === "unspecified"
            ? ` It is UNCLASSIFIED — call \`backlog_add\` again with the same title and a \`kind\` ` +
              `(bug | feature | investigate | test | docs | chore), plus \`blocked\`/\`blockedOn\` if it ` +
              `waits on someone outside the repo. An unclassified item makes the user's filters useless.`
            : "") +
          overlapNote(res.related, "Possible overlap —"),
      );
    },
  );

  const listTool = tool(
    "backlog_list",
    "List backlog items. By default the OPEN ones — provisional, open, doing — " +
      "read from the open files and the open index; closed files are not read. " +
      "`status` narrows to one of provisional | open | doing, or reads the " +
      "CLOSED items from the closed index: done | dismissed | all (paged: `limit` default 50, `offset`, " +
      "newest first). Use on intake, when the user asks what's parked, and at " +
      "the scope-met handoff (`status: provisional`) to batch keep/dismiss what " +
      "was auto-captured this turn. Before listing, open items whose fix is on " +
      "the project's branch (a commit with a `Backlog: <slug>` trailer) are " +
      "closed, and the answer names them.",
    {
      status: z
        .enum(["provisional", "open", "doing", "done", "dismissed", "all"])
        .optional()
        .describe("Filter; omit for every open item. done | dismissed | all read the closed items, paged."),
      limit: z.number().int().positive().max(200).optional().describe("Closed-item reads only: page size, default 50."),
      offset: z.number().int().nonnegative().optional().describe("Closed-item reads only: how many to skip, newest first."),
    },
    async ({ status, limit, offset }) => {
      // Derived done (backlog-derive.ts): what git proves fixed is closed first,
      // so the list a tab reads is the list as it is, not as it was last touched.
      const derived = await deriveBacklogFromGit(cwd);
      const derivedLine = derived.resolved.length
        ? `\n\nClosed just now because their fix is on ${derived.branch}: ${derived.resolved.map((r) => `\`${r.id}\` (${r.sha.slice(0, 9)})`).join(", ")}.`
        : "";
      const unknownLine = derived.unknown.length
        ? `\n\nCommit trailers naming no backlog item (a typo? nothing was created): ${derived.unknown.slice(0, 5).map((u) => `\`${u}\``).join(", ")}${derived.unknown.length > 5 ? ` and ${derived.unknown.length - 5} more` : ""}.`
        : "";
      if (status === "done" || status === "dismissed" || status === "all") {
        const page = await listResolved(cwd, {
          ...(status === "done" || status === "dismissed" ? { status } : {}),
          limit: limit ?? 50,
          offset: offset ?? 0,
        });
        if (page.items.length === 0) return textResult(status === "all" ? "No closed backlog items." : `No ${status} backlog items.`);
        const lines = page.items.map(
          (i) => `- [${i.status}${i.resolvedBy === "derived" ? " · derived" : ""}] (${i.severity}) ${i.title} — backlog/${i.id}.md${i.evidence ? ` · ${i.evidence.slice(0, 9)}` : ""}`,
        );
        return textResult(
          `Closed (${page.offset + 1}–${page.offset + page.items.length} of ${page.total}):\n${lines.join("\n")}` +
            (page.hasMore ? `\n\nMore: call backlog_list again with offset ${page.offset + page.items.length}.` : "") +
            derivedLine +
            unknownLine,
        );
      }
      const items = await listBacklog(cwd, status ? { status } : undefined);
      if (items.length === 0) {
        return textResult((status ? `No ${status} backlog items.` : "No open backlog items.") + derivedLine + unknownLine);
      }
      const lines = items.map((i) => {
        const held = i.status === "doing" ? describeClaim(i) : null;
        const mine = i.status === "doing" && marvinSessionId && i.claimedBy === marvinSessionId;
        const meta = [i.release, i.blocked && i.blockedOn ? `waits on ${i.blockedOn}` : ""].filter(Boolean);
        return `- [${i.status}${held ? ` · ${mine ? "held by THIS tab" : held}` : ""}] (${i.severity}) ${i.title}${meta.length ? ` · ${meta.join(" · ")}` : ""} — backlog/${i.id}.md`;
      });
      return textResult(
        `Backlog (${items.length}):\n${lines.join("\n")}` +
          (items.some((i) => i.status === "doing" && i.claimedBy && i.claimedBy !== marvinSessionId)
            ? `\n\nAn item marked \`doing · tab: …\` is being worked by ANOTHER tab right now — do not start it here; tell the user.`
            : "") +
          derivedLine +
          unknownLine,
      );
    },
  );

  // ADR-0113 — take an item before working it, so sibling tabs see the holder.
  const claimTool = tool(
    "backlog_claim",
    "CLAIM a backlog item before you start working it: marks it `doing` with " +
      "THIS tab as the holder, so other tabs running at the same time see it is " +
      "taken (`backlog_list` shows `doing · tab: …`). Refused, naming the holder, " +
      "when another tab already holds it — then tell the user and do not start it " +
      "here. Call it as the first step of working any backlog item, including one " +
      "you just parked yourself.",
    {
      id: z.string().min(1).describe("The item slug (from backlog_list)."),
    },
    async ({ id }) => {
      if (!marvinSessionId) return errorResult("claiming needs a session; this caller has none.");
      const res = await claimBacklogItem(cwd, id, { sessionId: marvinSessionId, ...(branch ? { branch } : {}) });
      if (!res.ok) return errorResult(res.error);
      return textResult(
        res.alreadyHeld
          ? `Backlog item \`${id}\` is already held by this tab.`
          : `Claimed backlog item \`${id}\` for this tab${branch ? ` (${branch})` : ""}. It shows as \`doing\` to every other tab; \`backlog_resolve\` releases it.`,
      );
    },
  );

  const resolveTool = tool(
    "backlog_resolve",
    "Resolve or review a backlog item by id — `keep` (confirm a provisional item " +
      "→ open), `dismissed` (won't do), or `done` (completed). Use `keep`/" +
      "`dismissed` at the handoff to clear provisional auto-captures. A " +
      "done/dismissed item drops from the open index and moves to the closed " +
      "index (its file stays where it is; `backlog_list status: done | dismissed | all` " +
      "reads it). Do not resolve by hand an item you fixed in a commit: put " +
      "`Backlog: <slug>` in that commit's message and it resolves itself once " +
      "the commit is on the project's branch.",
    {
      id: z.string().min(1).describe("The item slug (from backlog_list)."),
      resolution: z.enum(["keep", "done", "dismissed"]).describe("keep (provisional → open) | done | dismissed."),
      note: z.string().optional().describe("Optional one-line note appended to the item."),
    },
    async ({ id, resolution, note }) => {
      // `keep` promotes a provisional item to open; done/dismissed are terminal.
      const res =
        resolution === "keep"
          ? await setBacklogStatus(cwd, id, "open", note)
          : await resolveBacklogItem(cwd, { id, resolution, ...(note ? { note } : {}) });
      if (!res.ok) return errorResult(res.error);
      // ADR-0113 §3 — tell the tabs this touches, so none of them redoes it.
      let told = "";
      if (resolution !== "keep" && projectId && marvinSessionId) {
        try {
          const notices = notifyTabsOfResolution({ projectId, workDir: cwd, fromSessionId: marvinSessionId, fromBranch: branch, item: res.item });
          const n = notices.filter((x) => x.delivered !== "skipped").length;
          if (n) told = ` ${n} other tab${n === 1 ? " was" : "s were"} notified.`;
        } catch {
          /* a notice is best-effort */
        }
      }
      return textResult(
        (resolution === "keep"
          ? `Backlog item \`${id}\` kept (now open).`
          : `Backlog item \`${id}\` marked ${resolution}.${told}`) +
          overlapNote(res.related ?? [], "Still open —"),
      );
    },
  );

  // The model's field-edit path — the same `updateBacklogItem` the backlog
  // panel uses. Without it, re-blocking or condensing an item meant editing
  // `.marvin/backlog/*.md` by hand, which the tool boundary exists to prevent.
  const updateTool = tool(
    "backlog_update",
    "EDIT an existing backlog item's fields by id: `severity` (low | medium | " +
      "high, nothing else; `priority` is another name for it), `kind` (bug | feature | " +
      "investigate | test | docs | chore | unspecified; `type` is an alias), `release`, " +
      "`origin`, `blocked`/`blockedOn` (`waitsOn` is an alias), or REPLACE its `body`. The title and id never " +
      "change (a rename is a new item). The description (every line that is " +
      `not a \`> \` note) is capped at ${MAX_BODY_CHARS} chars and the \`> \` notes at ` +
      `${MAX_NOTES_CHARS}; an overflow of either is REFUSED and nothing is written — condense and ` +
      "retry. To add a dated progress note without changing status or claim, pass " +
      "`note` (it is appended; the body is untouched). When the notes are full the " +
      "call is refused: file the next point as a new item with `backlog_add` and " +
      "`relatesTo: <this slug>`. Replacing a body must keep every outcome, exit-gate, blocker and " +
      "build-order line: move history to a pointer (ADR, doc), never drop it. " +
      "Only change what the user approved; never re-prioritise or rewrite " +
      "items on the strength of `backlog_groom` alone (ADR-0063).",
    {
      id: z.string().min(1).describe("The item slug (from backlog_list)."),
      severity: z.string().optional().describe("low | medium | high — exactly these; anything else is refused."),
      priority: z.string().optional().describe("Alias of `severity`."),
      kind: z.enum(BACKLOG_KINDS).optional(),
      type: z.enum(Object.keys(BACKLOG_TYPE_ALIASES) as [string, ...string[]]).optional().describe("Alias of `kind`: bug, chore, debt (→ chore), idea (→ feature)."),
      release: z.string().optional().describe('Free text, e.g. "v3.2". Empty string clears it.'),
      origin: z.string().optional().describe("A session id or a review name. Empty string clears it."),
      waitsOn: z.string().optional().describe("Alias of `blockedOn` (and marks the item blocked). Empty string clears it."),
      blocked: z.boolean().optional(),
      blockedOn: z.string().max(200).optional().describe("Who or what it waits on; an item id where the blocker is another item. Empty string clears it."),
      note: z.string().min(1).optional().describe("A progress note appended as a dated `> note` line; status and claim unchanged."),
      body: z.string().min(1).optional().describe(`The full replacement body (description ≤ ${MAX_BODY_CHARS} chars, \`> \` notes ≤ ${MAX_NOTES_CHARS}).`),
    },
    async ({ id, severity, priority, kind, type, release, origin, waitsOn, blocked, blockedOn, body, note }) => {
      const rawSeverity = severity ?? priority;
      if (rawSeverity === undefined && kind === undefined && type === undefined && release === undefined && origin === undefined && waitsOn === undefined && blocked === undefined && blockedOn === undefined && body === undefined && note === undefined) {
        return errorResult("nothing to change — pass at least one of severity, kind, release, origin, blocked, blockedOn, body, note.");
      }
      let parsed: BacklogSeverity | undefined;
      if (rawSeverity !== undefined) {
        const p = parseSeverity(rawSeverity);
        if (!p.ok) return errorResult(p.error);
        parsed = p.value;
      }
      const res = await updateBacklogItem(cwd, id, {
        ...(parsed !== undefined ? { severity: parsed } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(type !== undefined ? { type: type as keyof typeof BACKLOG_TYPE_ALIASES } : {}),
        ...(release !== undefined ? { release } : {}),
        ...(origin !== undefined ? { origin } : {}),
        ...(waitsOn !== undefined ? { waitsOn } : {}),
        ...(blocked !== undefined ? { blocked } : {}),
        ...(blockedOn !== undefined ? { blockedOn } : {}),
        ...(body !== undefined ? { body } : {}),
        ...(note !== undefined ? { note } : {}),
      });
      if (!res.ok) return errorResult(res.error);
      const changed = [
        parsed !== undefined && `severity=${parsed}`,
        kind !== undefined && `kind=${kind}`,
        type !== undefined && `kind=${BACKLOG_TYPE_ALIASES[type as keyof typeof BACKLOG_TYPE_ALIASES]} (from type)`,
        release !== undefined && `release=${release || "(cleared)"}`,
        origin !== undefined && `origin=${origin || "(cleared)"}`,
        waitsOn !== undefined && `blockedOn=${waitsOn || "(cleared)"} (from waitsOn)`,
        blocked !== undefined && `blocked=${blocked}`,
        blockedOn !== undefined && `blockedOn=${blockedOn ? `"${blockedOn}"` : "(cleared)"}`,
        body !== undefined && `body (${res.item.body.length} chars)`,
        note !== undefined && "note appended",
      ].filter(Boolean);
      return textResult(`Backlog item \`${id}\` updated: ${changed.join(", ")}.`);
    },
  );

  const groomTool = tool(
    "backlog_groom",
    "REVIEW the backlog and report what looks wrong — near-duplicates, " +
      "auto-captured items never reviewed, items untouched for weeks, references " +
      "to files that no longer exist, and HIGH-severity items left sitting. " +
      "READ-ONLY: it changes nothing. Use it when the user asks to review / tidy " +
      "/ groom the backlog, at the start of a session that will work through " +
      "parked items, or when the backlog has grown enough that the user can't " +
      "scan it. Every finding is a HEURISTIC — relay them and let the user " +
      "decide. You MUST NOT resolve, merge, re-prioritise, or edit any item on " +
      "the strength of this report alone (ADR-0063).",
    {
      staleDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days untouched before an item counts as stale. Default 30."),
      maxFindings: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Cap on findings returned. Default 25."),
    },
    async ({ staleDays, maxFindings }) => {
      const items = await listBacklog(cwd);
      if (items.length === 0) return textResult("Backlog is empty — nothing to groom.");
      const report = groomBacklog(items, {
        now: new Date(),
        ...(staleDays ? { staleDays } : {}),
        ...(maxFindings ? { maxFindings } : {}),
        // Resolved against the project workDir. A path that escapes the
        // project is treated as present rather than missing: we can't verify
        // it, and reporting an unverifiable path as gone would be a lie.
        fileExists: (ref) => {
          const abs = resolve(cwd, ref);
          if (!abs.startsWith(resolve(cwd) + sep)) return true;
          return existsSync(abs);
        },
      });
      return textResult(renderGroomReport(report));
    },
  );

  return createSdkMcpServer({
    name: "marvin-backlog",
    version: "1.0.0",
    // ADR-0118 — deferred behind ToolSearch (the SDK default). ADR-0073 loaded
    // every MARVIN server up front; only `marvin-graph` (graphify-first would
    // deadlock without it) and `marvin-control` (the checkback guard needs
    // `schedule_wakeup` without a discovery step) still need that.
    tools: [addTool, listTool, resolveTool, updateTool, groomTool, claimTool],
  });
}
