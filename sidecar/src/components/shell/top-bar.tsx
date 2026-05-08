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
import type { PermissionStrategy } from "@/components/settings/permission-toggle";
import type { PersonalityMode } from "@/components/settings/personality-toggle";
import { ThemeToggle } from "@/components/settings/theme-toggle";
import {
  LayoutPopover,
  SetupPopover,
} from "@/components/shell/top-bar-popovers";

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
  /** Read-only summary in the Setup popover. Mutation routes
   *  through the dedicated `<ModelsDialog>` mounted by page.tsx
   *  (opened via `onOpenModelsDialog` below). */
  executorModel: string | null;
  advisorModel: string | null;
  personality: PersonalityMode;
  onPersonalityChange(v: PersonalityMode): void;

  // Panes
  panes: PaneState;
  onTogglePane(key: keyof PaneState): void;
  cwd: string;

  // Action buttons
  onOpenSettings(): void;
  onOpenShortcuts(): void;
  /** Open the dedicated Models dialog. The picker is too tall for the
   *  Setup popover, so the popover hosts a "Configure" button that
   *  triggers this. */
  onOpenModelsDialog(): void;
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
  personality,
  onPersonalityChange,
  panes,
  onTogglePane,
  cwd,
  onOpenSettings,
  onOpenShortcuts,
  onOpenModelsDialog,
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
        //
        // data-marvin-top-bar tags this header for the SwiftUI shell
        // CSS overrides in globals.css — the `pl-[82px]` traffic-
        // light gap and `pt-[var(--titlebar-h)]` overlay-bar gap are
        // both wrong inside the SwiftUI shell (the native title bar
        // is separate, not overlapping), so the rules reset both.
        data-tauri-drag-region
        data-marvin-top-bar
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
          // data-marvin-wordmark: redundant inside the SwiftUI shell
          // (the native NSWindow title already shows MARVIN). Hidden
          // in globals.css under [data-host-shell="swift"].
          data-marvin-wordmark
          className="font-display text-[22px] italic leading-none text-[color:var(--color-fg)] outline-none transition hover:opacity-80 disabled:cursor-default disabled:opacity-100"
        >
          marvin
        </button>
        <span
          data-marvin-version-pip
          className="hidden text-[10px] uppercase tracking-[0.28em] text-[color:var(--color-fg-faint)] md:inline"
        >
          v1
        </span>
        <div data-marvin-wordmark-divider className="mx-3 h-5 w-px bg-[color:var(--color-border)]" />
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
           * Two popovers replace the previous five `LabeledGroup`
           * blocks (perms, models, voice, theme, panes). Layout
           * holds the five pane toggles; Setup holds perms / models /
           * voice. Theme stays inline because it's a single icon-
           * toggle and the most-flipped control mid-session. The old
           * inline groups were gated by `xl:` / `2xl:` Tailwind
           * breakpoints — invisible on 1280-1536 px viewports despite
           * the Settings dialog claiming they "live in the top bar."
           * See [docs/reviews/2026-04-26-full-audit.md, finding #8].
           */}
          <LayoutPopover
            panes={panes}
            onTogglePane={onTogglePane}
            cwd={cwd}
          />
          <SetupPopover
            permissionStrategy={permissionStrategy}
            onPermissionStrategyChange={onPermissionStrategyChange}
            executorModel={executorModel}
            advisorModel={advisorModel}
            onOpenModelsDialog={onOpenModelsDialog}
            personality={personality}
            onPersonalityChange={onPersonalityChange}
          />
          <span data-marvin-theme-toggle>
            <ThemeToggle />
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={isEmpty}
            title="start a new MARVIN session (⌘⇧N)"
            data-marvin-new-session
            className="rounded-md border border-[color:var(--color-border)] px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-30"
          >
            new session
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="Settings — models, observability, appearance, permissions"
            aria-label="open settings"
            data-marvin-settings-button
            className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={onOpenShortcuts}
            title="keyboard shortcuts (?)"
            data-marvin-shortcuts-button
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
