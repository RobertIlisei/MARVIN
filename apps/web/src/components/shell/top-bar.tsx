"use client";

/**
 * TopBar — MARVIN's global header strip.
 *
 * Extracted from `apps/web/src/app/page.tsx` during the A2
 * decomposition pass. Previously lived inline as a 150-line
 * `const header = (...)` JSX expression next to the Home state, which
 * made state changes in the header's control panels (model picker,
 * permission toggle, perms/panes buttons) hard to navigate.
 *
 * No behaviour change — every prop corresponds 1:1 to a value Home
 * used to close over. If this component ever needs shared state
 * across siblings (e.g., a command palette that reads/writes the
 * same perms), promote to a Context; for now the prop bag is honest.
 *
 * Tauri window-drag behaviour: `data-tauri-drag-region` on the root
 * `<header>` makes the strip a draggable title-bar region in the
 * `.app`. The 82 px left padding clears the macOS traffic-light
 * cluster; `pt-[var(--titlebar-h)]` (28 px) reserves vertical space
 * so content never collides with the traffic lights in full-screen.
 */

import { CostPill } from "@/components/cost/cost-pill";
import { BranchBadge } from "@/components/project/branch-badge";
import { ProjectPicker } from "@/components/project/project-picker";
import type { ProjectRecord, VerifyResult } from "@/components/project/types";
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
import { LabeledGroup, PaneToggle } from "@/components/shell/page-helpers";

export interface PaneState {
  files: boolean;
  brain: boolean;
  graph: boolean;
  preview: boolean;
  terminal: boolean;
}

export interface TopBarProps {
  // Branding + session
  isEmpty: boolean;
  onReset(): void;

  // Projects — shapes match `useProjects()` in
  // components/project/use-projects.ts. If that API drifts, update
  // both in lockstep.
  projects: ProjectRecord[];
  active: ProjectRecord | null;
  projectsLoading: boolean;
  onSelectProject(id: string | null): Promise<void> | void;
  onRemoveProject(id: string): Promise<boolean> | boolean;
  onAddProject(input: {
    name?: string;
    workDir: string;
    setActive?: boolean;
  }): Promise<
    | { ok: true; project: ProjectRecord }
    | { ok: false; error: string; verify?: VerifyResult }
  >;
  verifyWorkDir(workDir: string): Promise<VerifyResult>;
  onResumeSession(projectId: string, sessionId: string): Promise<void> | void;
  pickerOpenSignal: number;

  // Branch badge refresh trigger
  sessionRefreshKey: number;

  // Permissions / models / voice / theme
  permissionStrategy: PermissionStrategy;
  onPermissionStrategyChange(s: PermissionStrategy): void;
  executorModel: string | null;
  advisorModel: string | null;
  onModelsChange(v: { executor: string | null; advisor: string | null }): void;
  personality: PersonalityMode;
  onPersonalityChange(v: PersonalityMode): void;

  // Panes
  panes: PaneState;
  onTogglePane(key: keyof PaneState): void;
  cwd: string;

  // Action buttons
  onOpenSettings(): void;
  onOpenShortcuts(): void;
}

export function TopBar({
  isEmpty,
  onReset,
  projects,
  active,
  projectsLoading,
  onSelectProject,
  onRemoveProject,
  onAddProject,
  verifyWorkDir,
  onResumeSession,
  pickerOpenSignal,
  sessionRefreshKey,
  permissionStrategy,
  onPermissionStrategyChange,
  executorModel,
  advisorModel,
  onModelsChange,
  personality,
  onPersonalityChange,
  panes,
  onTogglePane,
  cwd,
  onOpenSettings,
  onOpenShortcuts,
}: TopBarProps) {
  return (
    <>
      <header
        // Dragging the window by the header chrome only works inside
        // the Tauri `.app`. `data-tauri-drag-region` tells the webview
        // "this region is the window title bar for drag purposes" —
        // needed because tauri.conf.json sets
        // `titleBarStyle: "Overlay"` which hides the native bar and
        // overlays the traffic lights on top of our content. In a
        // normal browser tab the attribute is an unknown data-* and
        // has no effect.
        //
        // Interactive elements inside the header (buttons, inputs)
        // stop the drag because Tauri treats any click on a clickable
        // descendant as a regular click, not a drag. That's the
        // intended behaviour.
        data-tauri-drag-region
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[color:var(--color-border)] bg-[color:var(--material-toolbar)] pt-[var(--titlebar-h)] pr-5 pb-2.5 pl-[82px]"
      >
        <button
          type="button"
          onClick={isEmpty ? undefined : onReset}
          disabled={isEmpty}
          aria-label={
            isEmpty ? "marvin" : "return to home — start a new session"
          }
          title={isEmpty ? undefined : "return to home · ⌘⇧N"}
          className="font-display text-[22px] italic leading-none text-[color:var(--color-fg)] outline-none transition hover:opacity-80 disabled:cursor-default disabled:opacity-100"
        >
          marvin
        </button>
        <span className="hidden text-[10px] uppercase tracking-[0.28em] text-[color:var(--color-fg-faint)] md:inline">
          v1
        </span>
        <div className="mx-3 h-5 w-px bg-[color:var(--color-border)]" />
        <ProjectPicker
          projects={projects}
          active={active}
          loading={projectsLoading}
          onSelect={onSelectProject}
          onRemove={onRemoveProject}
          onAdd={onAddProject}
          verifyWorkDir={verifyWorkDir}
          onResumeSession={onResumeSession}
          openSignal={pickerOpenSignal}
        />
        <BranchBadge
          cwd={active?.workDir ?? null}
          refreshKey={sessionRefreshKey}
        />
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
          <CostPill
            projectId={active?.id ?? null}
            refreshKey={sessionRefreshKey}
          />
          {/*
           * perms / models / voice only show on wide viewports — they're
           * also accessible via the ⚙ Settings panel, so we collapse
           * them instead of letting them clip on medium screens. Theme
           * flip stays visible since users hit it mid-session more
           * than the others. `panes` toggles stay too (quick-flip
           * essentials).
           */}
          <LabeledGroup label="perms" className="hidden xl:inline-flex">
            <PermissionToggle
              value={permissionStrategy}
              onChange={onPermissionStrategyChange}
            />
          </LabeledGroup>
          <LabeledGroup label="models" className="hidden xl:inline-flex">
            <ModelPicker
              executor={executorModel}
              advisor={advisorModel}
              onChange={onModelsChange}
            />
          </LabeledGroup>
          <LabeledGroup label="voice" className="hidden 2xl:inline-flex">
            <PersonalityToggle
              value={personality}
              onChange={onPersonalityChange}
            />
          </LabeledGroup>
          <LabeledGroup label="theme">
            <ThemeToggle />
          </LabeledGroup>
          <LabeledGroup label="panes">
            <PaneToggle
              label="files"
              active={panes.files}
              onClick={() => onTogglePane("files")}
              kbd="⌘B"
              tip="project file tree"
            />
            <PaneToggle
              label="graph"
              active={panes.graph}
              onClick={() => onTogglePane("graph")}
              kbd="⌘G"
              tip="knowledge graph of the codebase"
            />
            <PaneToggle
              label="brain"
              active={panes.brain}
              onClick={() => onTogglePane("brain")}
              tip="live MARVIN brain visualization"
            />
            <PaneToggle
              label="preview"
              active={panes.preview}
              onClick={() => onTogglePane("preview")}
              disabled={!cwd}
              kbd="⌘P"
              tip="live web preview of dev server"
            />
            <PaneToggle
              label="term"
              active={panes.terminal}
              onClick={() => onTogglePane("terminal")}
              disabled={!cwd}
              kbd="⌘J"
              tip="embedded terminal in the project cwd"
            />
          </LabeledGroup>
          <button
            type="button"
            onClick={onReset}
            disabled={isEmpty}
            title="start a new MARVIN session (⌘⇧N)"
            className="rounded-md border border-[color:var(--color-border)] px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            new session
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="Settings — models, observability, appearance, permissions"
            aria-label="open settings"
            className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={onOpenShortcuts}
            title="keyboard shortcuts (?)"
            className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
          >
            ?
          </button>
        </div>
      </header>
      <div className="status-rail" aria-hidden />
    </>
  );
}
