"use client";

/**
 * TopBar popover trios — Layout (panes) and Setup (perms / models / voice).
 *
 * Replaces the inline `<LabeledGroup>`s that previously spread perms,
 * models, voice, panes, and theme across the header. The original layout
 * needed `xl:` and `2xl:` breakpoint hides to fit on smaller screens —
 * which made the controls invisible on 1280-1536 px viewports even
 * though Settings claimed they "live in the top bar." Two popovers
 * collapse the same controls into a stable shape that holds at 1024 px+.
 *
 * Reuses existing components (PermissionToggle, ModelPicker,
 * PersonalityToggle, PaneToggle) verbatim — this file is just a
 * placement change. The popover primitive is the shared
 * `@marvin/ui/dropdown-menu`; children that aren't
 * `DropdownMenuItem` don't auto-close, so the toggles work normally
 * inside.
 *
 * See [docs/reviews/2026-04-26-full-audit.md, finding #8].
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@marvin/ui/dropdown-menu";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type ReactNode,
} from "react";

import {
  type PermissionStrategy,
  PermissionToggle,
} from "@/components/settings/permission-toggle";
import {
  type PersonalityMode,
  PersonalityToggle,
} from "@/components/settings/personality-toggle";
import { PaneToggle } from "@/components/shell/page-helpers";

interface PaneState {
  files: boolean;
  brain: boolean;
  graph: boolean;
  preview: boolean;
  terminal: boolean;
}

/* ---------------- Layout popover ---------------- */

export interface LayoutPopoverProps {
  panes: PaneState;
  onTogglePane(key: keyof PaneState): void;
  cwd: string;
}

/**
 * Compact button used as the trigger for both popovers.
 *
 * **forwardRef + ...rest is load-bearing.** Radix's
 * `<DropdownMenuTrigger asChild>` clones its child and injects:
 *   - the `onClick` handler that toggles the menu open/closed
 *   - `aria-expanded`, `aria-haspopup`, `data-state`
 *   - a ref for focus management + outside-click detection
 *
 * The previous version of this component swallowed all three by not
 * forwarding the ref and not spreading `...rest`. Visually the
 * trigger looked correct, but clicking did nothing because Radix's
 * onClick never reached the underlying `<button>`.
 */
type PopoverButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: ReactNode;
  countBadge?: number;
};

const PopoverButton = forwardRef<HTMLButtonElement, PopoverButtonProps>(
  function PopoverButton({ label, countBadge, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={`inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] data-[state=open]:border-[color:var(--color-border-strong)] data-[state=open]:text-[color:var(--color-fg)] ${className ?? ""}`.trim()}
      >
        {label}
        {countBadge != null && countBadge > 0 && (
          <span className="rounded-full bg-[color:var(--color-accent-glow)] px-1.5 py-px font-mono text-[9px] text-[color:var(--color-accent)]">
            {countBadge}
          </span>
        )}
      </button>
    );
  },
);

export function LayoutPopover({
  panes,
  onTogglePane,
  cwd,
}: LayoutPopoverProps) {
  // Count visible work surfaces (`brain` is the side-pane decoration; not
  // counted here — the count badge means "how many work panes are open".
  // Kept consistent with how `panes.brain` reads in page.tsx (always-on
  // by default, decorative).
  const open =
    (panes.files ? 1 : 0) +
    (panes.graph ? 1 : 0) +
    (panes.preview ? 1 : 0) +
    (panes.terminal ? 1 : 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PopoverButton
          label={
            <>
              <span aria-hidden>▣</span>
              <span>layout</span>
            </>
          }
          countBadge={open}
          title="Toggle panes — files, graph, brain, preview, terminal"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        // p-2 instead of p-1 so the body breathes; min-width keeps the
        // grid from collapsing on short labels.
        className="min-w-[260px] p-2"
      >
        <div className="px-1.5 pb-1.5 font-mono text-[9px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)]">
          panes
        </div>
        <ul className="flex flex-col gap-1.5">
          <PaneRow
            label="files"
            kbd="⌘B"
            tip="project file tree"
            active={panes.files}
            onClick={() => onTogglePane("files")}
          />
          <PaneRow
            label="graph"
            kbd="⌘G"
            tip="knowledge graph of the codebase"
            active={panes.graph}
            onClick={() => onTogglePane("graph")}
          />
          <PaneRow
            label="brain"
            tip="live MARVIN brain visualization"
            active={panes.brain}
            onClick={() => onTogglePane("brain")}
          />
          <PaneRow
            label="preview"
            kbd="⌘P"
            tip="live web preview of dev server"
            active={panes.preview}
            disabled={!cwd}
            onClick={() => onTogglePane("preview")}
          />
          <PaneRow
            label="terminal"
            kbd="⌘J"
            tip="embedded terminal in the project cwd"
            active={panes.terminal}
            disabled={!cwd}
            onClick={() => onTogglePane("terminal")}
          />
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaneRow({
  label,
  kbd,
  tip,
  active,
  disabled,
  onClick,
}: {
  label: string;
  kbd?: string;
  tip: string;
  active: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <li
      className={`flex items-center justify-between rounded-md px-2 py-1.5 ${disabled ? "opacity-40" : "hover:bg-[color:var(--color-fg)]/[0.04]"}`}
    >
      <div className="flex flex-col">
        <span className="font-mono text-[11px] text-[color:var(--color-fg)]">
          {label}
        </span>
        <span className="text-[10px] text-[color:var(--color-fg-faint)]">
          {tip}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {kbd && (
          <span className="font-mono text-[10px] text-[color:var(--color-fg-faint)]">
            {kbd}
          </span>
        )}
        <PaneToggle
          label={active ? "on" : "off"}
          active={active}
          {...(disabled ? { disabled: true } : {})}
          onClick={onClick}
        />
      </div>
    </li>
  );
}

/* ---------------- Setup popover ---------------- */

export interface SetupPopoverProps {
  permissionStrategy: PermissionStrategy;
  onPermissionStrategyChange(s: PermissionStrategy): void;
  executorModel: string | null;
  advisorModel: string | null;
  /** Open the Models dialog. The picker doesn't fit comfortably in
   *  the popover (it's tall — preset cards + two selects) so it lives
   *  in a dedicated dialog and the popover just has a button to open
   *  it. The current selection is rendered as a one-line summary
   *  so users see what's active without opening the dialog. */
  onOpenModelsDialog(): void;
  personality: PersonalityMode;
  onPersonalityChange(v: PersonalityMode): void;
}

/** Short, lossy summary of the current model pair for the popover row. */
function summariseModels(executor: string | null, advisor: string | null): string {
  const trim = (m: string) => m.replace(/^claude-/, "").replace(/-2\d{6}$/, "");
  if (!executor && !advisor) return "default · runtime decides";
  if (executor && !advisor) return trim(executor);
  if (executor && advisor) return `${trim(executor)} → ${trim(advisor)}`;
  return advisor ? `default → ${trim(advisor)}` : "default";
}

export function SetupPopover(props: SetupPopoverProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PopoverButton
          label={
            <>
              <span aria-hidden>⚒</span>
              <span>setup</span>
            </>
          }
          title="Permissions, models, and voice — used to live across three header groups"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-[320px] p-3"
      >
        <SetupRow label="perms">
          <PermissionToggle
            value={props.permissionStrategy}
            onChange={props.onPermissionStrategyChange}
          />
        </SetupRow>

        <Divider />

        {/* Models lives in a dedicated dialog (apps/web/src/components/
            settings/models-dialog.tsx). The popover just shows the
            current pair and a "Configure" button — the full picker
            with its preset cards + two selects is too tall to fit
            inside a Radix dropdown content cleanly (audit-fix
            follow-up: user reported scroll juggling). */}
        <div className="flex flex-col gap-1.5 px-1 py-1.5">
          <span className="font-mono text-[9px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)]">
            models
          </span>
          <button
            type="button"
            onClick={props.onOpenModelsDialog}
            className="flex w-full items-center justify-between gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/40 px-3 py-2 text-left transition hover:border-[color:var(--color-border-strong)] hover:bg-[color:var(--color-bg-elev)]/70"
          >
            <span className="flex flex-col">
              <span className="font-mono text-[11px] text-[color:var(--color-fg)]">
                {summariseModels(props.executorModel, props.advisorModel)}
              </span>
              <span className="font-mono text-[10px] text-[color:var(--color-fg-faint)]">
                executor / advisor — click to configure
              </span>
            </span>
            <span aria-hidden className="font-mono text-[12px] text-[color:var(--color-fg-faint)]">
              →
            </span>
          </button>
        </div>

        <Divider />

        <SetupRow label="voice">
          <PersonalityToggle
            value={props.personality}
            onChange={props.onPersonalityChange}
          />
        </SetupRow>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SetupRow({
  label,
  stack,
  children,
}: {
  label: string;
  /** When true, label sits on its own line above the control. */
  stack?: boolean;
  children: ReactNode;
}) {
  if (stack) {
    return (
      <div className="px-1 py-1.5">
        <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)]">
          {label}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
        {label}
      </span>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-[color:var(--color-border)]" />;
}
