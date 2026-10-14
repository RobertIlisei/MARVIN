/**
 * The model each helper role runs on (ADR-0126).
 *
 * The executor and the advisor are picked per session (ADR-0108 posture).
 * Everything else MARVIN runs a model for — the scout, the graph-extractor,
 * Claude Code's own background calls, the server-side advisor (ADR-0125), and
 * the off-turn jobs (commit messages, practice drafting, the session auditor,
 * skill discovery)
 * — used to pin a tier in code. On OpenRouter a pinned Anthropic id is a
 * request to a model that isn't there (ADR-0096), so every role here resolves
 * against the ACTIVE provider's live catalogue:
 *
 *   - no override → the role's default: a tier (`latestForTier`), or "inherit"
 *     (the session's own model), or "off";
 *   - an override → used only if the active catalogue lists it. A choice saved
 *     under one provider and stale under another falls back to the default and
 *     is logged — switching provider must never break a turn.
 *
 * Stored app-wide at `<MARVIN_DATA_DIR>/role-models.json`: these roles are
 * not part of a conversation, and the off-turn ones have no session at all.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  activeProvider,
  ensureProviderModelId,
  latestForTier,
  listModelsCached,
  type ModelInfo,
} from "./models";

export type RoleDefault =
  | { kind: "tier"; tier: ModelInfo["tier"] }
  | { kind: "inherit" }
  | { kind: "off" };

export interface RoleSpec {
  label: string;
  description: string;
  default: RoleDefault;
  /** Anthropic-only roles resolve to null on any other provider. */
  anthropicOnly?: boolean;
}

export const ROLES = {
  scout: {
    label: "Scout",
    description: "read-only research subagent",
    default: { kind: "inherit" },
  },
  graphExtractor: {
    label: "Graph extractor",
    description: "graphify semantic-pass subagent",
    default: { kind: "tier", tier: "haiku" },
  },
  backgroundModel: {
    label: "Background",
    description: "Claude Code's own small-model calls (the `haiku` alias)",
    default: { kind: "inherit" },
  },
  serverAdvisor: {
    label: "Server advisor",
    description: "Claude's built-in advisor — sees the whole transcript; off by default",
    default: { kind: "off" },
    anthropicOnly: true,
  },
  commitMessage: {
    label: "Commit messages",
    description: "drafts a commit message from the staged diff",
    default: { kind: "tier", tier: "haiku" },
  },
  practiceDraft: {
    label: "Practice drafts",
    description: "drafts a practice rule's message from aggregates",
    default: { kind: "tier", tier: "sonnet" },
  },
  sessionAuditor: {
    label: "Session auditor",
    description: "read-only audit of a session, reported to you",
    default: { kind: "tier", tier: "sonnet" },
  },
  skillDiscoverer: {
    label: "Skill discovery",
    description: "proposes project skills from the codebase",
    default: { kind: "tier", tier: "sonnet" },
  },
} as const satisfies Record<string, RoleSpec>;

export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as Role[];

/** A role's stored choice: a model id, "off" (only where off is meaningful),
 *  or absent for the default. */
export type RoleModels = Partial<Record<Role, string>>;

/** Model ids are opaque provider strings; this only refuses what no provider
 *  names a model with (whitespace, control characters, absurd length). */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,199}$/;

export function roleModelsPath(): string {
  const root = process.env.MARVIN_DATA_DIR?.trim() || path.join(homedir(), ".marvin");
  return path.join(root, "role-models.json");
}

/** Validate a role map. Returns the clean map, or the reasons it was refused. */
export function validateRoleModels(input: unknown): { ok: true; roles: RoleModels } | { ok: false; errors: string[] } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["roles must be an object"] };
  }
  const errors: string[] = [];
  const roles: RoleModels = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(key in ROLES)) {
      errors.push(`unknown role: ${key}`);
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") {
      errors.push(`${key}: must be a string`);
      continue;
    }
    if (value === "off") {
      if (ROLES[key as Role].default.kind !== "off") errors.push(`${key}: cannot be off`);
      else roles[key as Role] = value;
      continue;
    }
    if (!MODEL_ID_RE.test(value)) {
      errors.push(`${key}: not a model id`);
      continue;
    }
    roles[key as Role] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, roles };
}

export function readRoleModels(): RoleModels {
  const p = roleModelsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { roles?: unknown };
    const v = validateRoleModels(parsed.roles ?? {});
    // A hand-edited file with one bad entry must not cost the user every
    // other choice: keep what validates, drop the rest.
    if (v.ok) return v.roles;
    const kept: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(parsed.roles as Record<string, unknown>)) {
      if (validateRoleModels({ [k]: val }).ok) kept[k] = val;
    }
    const retry = validateRoleModels(kept);
    return retry.ok ? retry.roles : {};
  } catch {
    return {};
  }
}

export function writeRoleModels(roles: RoleModels): void {
  const p = roleModelsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, roles }, null, 2)}\n`);
  renameSync(tmp, p);
}

/**
 * The model a role runs on right now, against the active provider.
 * `"inherit"` = use the session's own model (the caller decides what that
 * means); `null` = the role is off, or has nothing it can run on.
 */
export async function resolveRoleModel(
  role: Role,
  stored: RoleModels = readRoleModels(),
): Promise<string | "inherit" | null> {
  const spec: RoleSpec = ROLES[role];
  const provider = activeProvider();
  if (spec.anthropicOnly && provider !== "anthropic") return null;

  const choice = stored[role];
  if (choice === "off") return null;
  if (choice) {
    const catalogue = (await listModelsCached()).models;
    // Only a live catalogue can say a choice is stale; on the fallback list
    // the user's explicit pick is the better guess.
    const live = catalogue.some((m) => m.live);
    if (!live || catalogue.some((m) => m.id === choice)) return choice;
    console.log(
      `[marvin.telemetry] ${JSON.stringify({
        kind: "model.role.stale",
        role,
        provider,
        choice,
        at: new Date().toISOString(),
      })}`,
    );
  }

  const d = spec.default;
  if (d.kind === "off") return null;
  if (d.kind === "inherit") return "inherit";
  return ensureProviderModelId(await latestForTier(d.tier));
}

/** What the UI shows: every role, its stored choice and what it resolves to. */
export async function describeRoleModels(): Promise<
  Array<{ role: Role; label: string; description: string; default: RoleDefault; anthropicOnly: boolean; choice: string | null; resolved: string | null }>
> {
  const stored = readRoleModels();
  return Promise.all(
    ROLE_NAMES.map(async (role) => {
      const spec: RoleSpec = ROLES[role];
      return {
        role,
        label: spec.label,
        description: spec.description,
        default: spec.default,
        anthropicOnly: spec.anthropicOnly ?? false,
        choice: stored[role] ?? null,
        resolved: await resolveRoleModel(role, stored),
      };
    }),
  );
}

/**
 * What the per-turn roles add to a turn's env and flag-layer settings.
 * Pure, so the on/off contract is pinned by a test, not by reading sdk-runner.
 *
 *  - background model picked → the `haiku` alias Claude Code uses for its own
 *    small calls points at it; default leaves Claude Code (and the user's env)
 *    in charge.
 *  - server advisor on → `settings.advisorModel`; off (or not on this
 *    provider) → the tool is DISABLED, so a user-level `advisorModel` written
 *    by `/advisor` in a Claude Code terminal never reaches a MARVIN turn
 *    (settingSources includes "user" — ADR-0118, ADR-0125).
 */
export function roleTurnOverrides(
  backgroundModel: string | "inherit" | null,
  serverAdvisorModel: string | "inherit" | null,
): { env: Record<string, string>; settings: { advisorModel?: string } } {
  const env: Record<string, string> = {};
  if (backgroundModel && backgroundModel !== "inherit") {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = backgroundModel;
    env.ANTHROPIC_SMALL_FAST_MODEL = backgroundModel;
  }
  const advisorOn = !!serverAdvisorModel && serverAdvisorModel !== "inherit";
  if (!advisorOn) env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1";
  return { env, settings: advisorOn ? { advisorModel: serverAdvisorModel } : {} };
}
