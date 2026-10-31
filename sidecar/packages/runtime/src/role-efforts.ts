/**
 * The reasoning effort a helper role runs at — today only the supervisor
 * (ADR-0127). A sibling of `role-models.ts`, in its own file on purpose: the
 * Models dialog replaces the whole `role-models.json` map, and an effort that
 * lived in it would be rewritten by every save.
 *
 * Raising effort widens what the supervisor spends, so the only writer is the
 * user's click (`PATCH /api/models/roles`); no supervisor verb reaches this
 * module and the tool gate denies a tab writing the file (sdk-runner.ts).
 *
 * Stored app-wide at `<MARVIN_DATA_DIR>/role-efforts.json`; absent = Default
 * (the SDK's own effort — no `effort` option is passed).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { EFFORT_LEVELS, effortOptionsFor, type ReasoningEffort } from "./effort";

export const EFFORT_ROLES = ["supervisor"] as const;
export type EffortRole = (typeof EFFORT_ROLES)[number];
export type RoleEfforts = Partial<Record<EffortRole, ReasoningEffort>>;

export function isEffortRole(role: unknown): role is EffortRole {
  return typeof role === "string" && (EFFORT_ROLES as readonly string[]).includes(role);
}

/** A rung of the SDK ladder, exactly — no legacy aliases (`fast`, `thinking`): this is a new store. */
export function isEffortRung(v: unknown): v is ReasoningEffort {
  return typeof v === "string" && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export function roleEffortsPath(): string {
  const root = process.env.MARVIN_DATA_DIR?.trim() || path.join(homedir(), ".marvin");
  return path.join(root, "role-efforts.json");
}

/** What is stored. A hand-edited bad entry is dropped, never thrown on and never kept. */
export function readRoleEfforts(): RoleEfforts {
  const p = roleEffortsPath();
  if (!existsSync(p)) return {};
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { efforts?: Record<string, unknown> };
    const out: RoleEfforts = {};
    for (const role of EFFORT_ROLES) {
      const v = parsed.efforts?.[role];
      if (isEffortRung(v)) out[role] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Change ONE role's effort; `null` puts it back on Default. Throws on a non-rung. */
export function setRoleEffort(role: EffortRole, effort: ReasoningEffort | null): RoleEfforts {
  if (effort !== null && !isEffortRung(effort)) throw new Error(`${role}: not an effort rung`);
  const next: RoleEfforts = { ...readRoleEfforts() };
  if (effort === null) delete next[role];
  else next[role] = effort;
  const p = roleEffortsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, efforts: next }, null, 2)}\n`);
  renameSync(tmp, p);
  return next;
}

export interface EffortResolution {
  /** What the user stored; null = Default. */
  choice: ReasoningEffort | null;
  /** What a wake will pass as `effort`; null = pass none (Default, or the choice did not fit the model). */
  resolved: ReasoningEffort | null;
  /** The rungs the model the role will run on can run. */
  options: ReasoningEffort[];
  /** A stored choice the model cannot run — the UI says so, the wake runs on Default. */
  fellBack: boolean;
}

/** The effort a role runs at on `model` (the model it resolved to; null when unknown). */
export function resolveRoleEffort(role: EffortRole, model: string | null | undefined): EffortResolution {
  const choice = readRoleEfforts()[role] ?? null;
  const options = effortOptionsFor(model);
  if (choice === null) return { choice, resolved: null, options, fellBack: false };
  const fits = options.includes(choice);
  return { choice, resolved: fits ? choice : null, options, fellBack: !fits };
}
