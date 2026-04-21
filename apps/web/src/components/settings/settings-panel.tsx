"use client";

/**
 * MARVIN's unified settings panel — single-entry dialog with sidebar
 * tabs for Observability, Models, Appearance, Permissions, and
 * Project info.
 *
 * Scope note: this panel *complements* the header pills rather than
 * replacing them. The pills stay for quick-flip muscle memory; the
 * panel is the authoritative "everything lives here" view. Each tab
 * re-uses an existing component (ModelPicker, ThemeToggle, etc.) so
 * there's one source of truth for each setting's behaviour.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@marvin/ui/dialog";

import { HoneycombConfigForm } from "@/components/settings/honeycomb-config";
import { ModelPicker } from "@/components/settings/model-picker";
import {
  type PermissionStrategy,
  PermissionToggle,
} from "@/components/settings/permission-toggle";
import {
  type PersonalityMode,
  PersonalityToggle,
} from "@/components/settings/personality-toggle";
import { ThemeToggle } from "@/components/settings/theme-toggle";

export type SettingsTab =
  | "observability"
  | "models"
  | "appearance"
  | "permissions"
  | "project";

export interface SettingsPanelProps {
  open: boolean;
  onOpenChange(open: boolean): void;

  /**
   * Fully controlled — parent owns the active tab. Enables deep-links
   * ("open at Observability") and stops SettingsPanel from owning
   * its own state that would drift out of sync with the caller.
   */
  tab: SettingsTab;
  onTabChange(next: SettingsTab): void;

  /** Per-project context — routes that need a cwd receive it. */
  cwd: string | null;
  projectName: string | null;

  /** Model picker state — forwarded to the existing component. */
  executorModel: string | null;
  advisorModel: string | null;
  onModelsChange(next: { executor: string | null; advisor: string | null }): void;

  /** Personality toggle state. */
  personality: PersonalityMode;
  onPersonalityChange(p: PersonalityMode): void;

  /** Permission toggle state. */
  permissionStrategy: PermissionStrategy;
  onPermissionChange(s: PermissionStrategy): void;

  /** Forwarded from HoneycombConfigForm so the host can mirror status elsewhere (brain-panel row). */
  onHoneycombStatusChange?(status: {
    configured: boolean;
    source: "env" | "workdir" | "global" | "none";
    environment: string | null;
    dataset: string | null;
  }): void;
}

const TABS: Array<{ id: SettingsTab; label: string; hint: string }> = [
  { id: "observability", label: "Observability", hint: "Honeycomb traces" },
  { id: "models", label: "Models", hint: "Executor + advisor" },
  { id: "appearance", label: "Appearance", hint: "Theme + personality" },
  {
    id: "permissions",
    label: "Permissions",
    hint: "Tool-use confirm gate",
  },
  { id: "project", label: "Project", hint: "Active working dir" },
];

export function SettingsPanel(props: SettingsPanelProps) {
  const { tab, onTabChange } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Per-project config lives under{" "}
            <code>&lt;project&gt;/.marvin/</code>. User-global state is under{" "}
            <code>~/.marvin/</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[9rem_1fr] gap-5 min-h-[20rem]">
          <nav
            aria-label="Settings sections"
            className="flex flex-col gap-0.5 border-r border-[color:var(--color-border)] pr-2 font-mono text-[11px]"
          >
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onTabChange(t.id)}
                  className={`flex flex-col items-start rounded px-2 py-1.5 text-left transition ${
                    active
                      ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-fg)]"
                      : "text-[color:var(--color-fg-dim)] hover:bg-[color:var(--color-bg-elev)]/60 hover:text-[color:var(--color-fg)]"
                  }`}
                >
                  <span>{t.label}</span>
                  <span className="text-[10px] text-[color:var(--color-fg-faint)]">
                    {t.hint}
                  </span>
                </button>
              );
            })}
          </nav>

          <section className="min-w-0">
            {tab === "observability" && (
              <HoneycombConfigForm
                cwd={props.cwd}
                {...(props.onHoneycombStatusChange
                  ? { onStatusChange: props.onHoneycombStatusChange }
                  : {})}
              />
            )}
            {tab === "models" && (
              <div className="flex flex-col gap-3 font-mono text-[11px]">
                <SectionHeader
                  title="Model picker"
                  hint="Two-slot executor + advisor. Explicit body override > this picker > defaultModel."
                />
                <div>
                  <ModelPicker
                    executor={props.executorModel}
                    advisor={props.advisorModel}
                    onChange={props.onModelsChange}
                  />
                </div>
              </div>
            )}
            {tab === "appearance" && (
              <div className="flex flex-col gap-4 font-mono text-[11px]">
                <SectionHeader
                  title="Theme"
                  hint="Light / dark toggle. Persists to localStorage; Monaco + xterm follow."
                />
                <ThemeToggle />
                <SectionHeader
                  title="Personality"
                  hint="MARVIN's prose voice — dry Hitchhiker's-Guide style vs. neutral assistant."
                />
                <PersonalityToggle
                  value={props.personality}
                  onChange={props.onPersonalityChange}
                />
              </div>
            )}
            {tab === "permissions" && (
              <div className="flex flex-col gap-3 font-mono text-[11px]">
                <SectionHeader
                  title="Tool-use permissions"
                  hint="Auto bypasses the confirm card for Edit/Write/Bash. Gated pauses on each. Hard-denies always apply. See ADR-0004."
                />
                <PermissionToggle
                  value={props.permissionStrategy}
                  onChange={props.onPermissionChange}
                />
              </div>
            )}
            {tab === "project" && (
              <div className="flex flex-col gap-3 font-mono text-[11px]">
                <SectionHeader
                  title="Active project"
                  hint="Per-project MARVIN state lives at .marvin/ inside the workDir."
                />
                <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/50 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[color:var(--color-fg-faint)]">
                      name
                    </span>
                    <span className="truncate text-[color:var(--color-fg)]">
                      {props.projectName ?? "—"}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-3">
                    <span className="text-[color:var(--color-fg-faint)]">
                      workDir
                    </span>
                    <span className="truncate text-[color:var(--color-fg)]/85">
                      {props.cwd ?? "—"}
                    </span>
                  </div>
                </div>
                <p className="text-[color:var(--color-fg-dim)]">
                  Switch projects via the header picker (<kbd>⌘K</kbd>) — this
                  panel doesn't change the active project, only views it.
                </p>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
        {title}
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-[color:var(--color-fg-dim)]">
        {hint}
      </p>
    </div>
  );
}
