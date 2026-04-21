"use client";

/**
 * MARVIN's Settings panel.
 *
 * Scope: **Observability only**. Everything else that used to live in
 * here (Models, Appearance, Permissions, Project) is accessible from
 * the top bar — duplicating the controls in a dialog just crowded the
 * layout and forced users to hunt in two places. The dialog now has
 * one job: configure Honeycomb (the only setting that needs a real
 * form with secrets, test-connection, save/delete).
 *
 * Single-pane layout: dialog chrome → title + subtitle → Honeycomb
 * form. Generous padding. No sidebar, no tabs.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@marvin/ui/dialog";

import { HoneycombConfigForm } from "@/components/settings/honeycomb-config";

/**
 * Kept for back-compat with callers that imported the type. Now a
 * single-value union — "observability" is the only tab. Remove when
 * nothing references it externally.
 */
export type SettingsTab = "observability";

export interface SettingsPanelProps {
  open: boolean;
  onOpenChange(open: boolean): void;

  /** Per-project context — the Honeycomb form needs the cwd to write to `<project>/.marvin/`. */
  cwd: string | null;

  /** Forwarded from HoneycombConfigForm so the host can mirror status elsewhere (brain-panel row). */
  onHoneycombStatusChange?(status: {
    configured: boolean;
    source: "env" | "workdir" | "global" | "none";
    environment: string | null;
    dataset: string | null;
  }): void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        // Roomy enough for the Honeycomb form's four inputs + advanced
        // accordion. p-0 so the panel paints its own padding and the
        // close-X sits inside our header row, not over form content.
        className="sm:max-w-2xl p-0 overflow-hidden"
        // Don't auto-close when the pointerdown that OPENED the dialog
        // bubbles up to the document — happens because the trigger (⚙
        // in the header) lives inside a `data-tauri-drag-region`
        // container whose pointer events travel to the document before
        // Radix's DismissableLayer installs its listener. Without this
        // guard the dialog opens + closes in the same tick and the
        // user sees nothing.
        onPointerDownOutside={(e) => {
          const target = e.target;
          if (
            target instanceof Element &&
            target.closest("[data-tauri-drag-region]")
          ) {
            e.preventDefault();
          }
        }}
        onInteractOutside={(e) => {
          const target = e.target;
          if (
            target instanceof Element &&
            target.closest("[data-tauri-drag-region]")
          ) {
            e.preventDefault();
          }
        }}
      >
        <div className="flex flex-col max-h-[min(85vh,44rem)]">
          {/* ------------------------------------------------------------------
               Header — visible title + subtitle. Radix's a11y title lives
               inside a visually-hidden wrapper so screen readers still
               pick it up.
               ------------------------------------------------------------------ */}
          <DialogHeader className="sr-only">
            <DialogTitle>Settings — Observability</DialogTitle>
            <DialogDescription>
              Configure Honeycomb API credentials, environment, and dataset for
              MARVIN&apos;s tool-loop traces.
            </DialogDescription>
          </DialogHeader>

          <header
            className="flex flex-col gap-1.5 px-8 pt-7 pb-5 border-b"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div className="text-[10px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)]">
              marvin · settings
            </div>
            <h2 className="font-display text-[24px] leading-tight text-[color:var(--color-fg)]">
              Observability
            </h2>
            <p className="text-[12.5px] leading-relaxed text-[color:var(--color-fg-dim)] max-w-prose">
              Honeycomb traces for MARVIN&apos;s tool loop. Set an API key,
              environment, and optional dataset — or let MARVIN pick up{" "}
              <code className="font-mono text-[11.5px] text-[color:var(--color-fg)]">
                HONEYCOMB_API_KEY
              </code>{" "}
              from the shell environment.
            </p>
          </header>

          {/* ------------------------------------------------------------------
               Body — the Honeycomb form. Scrolls internally if the
               "advanced" section is open and the window is short.
               ------------------------------------------------------------------ */}
          <div className="scroll-thin overflow-y-auto px-8 py-7">
            <HoneycombConfigForm
              cwd={props.cwd}
              {...(props.onHoneycombStatusChange
                ? { onStatusChange: props.onHoneycombStatusChange }
                : {})}
            />
          </div>

          {/* ------------------------------------------------------------------
               Footnote — where config is written, quick pointer to the
               other settings (now in the top bar).
               ------------------------------------------------------------------ */}
          <footer
            className="px-8 py-3.5 border-t text-[11px] leading-relaxed text-[color:var(--color-fg-faint)] flex flex-wrap items-center justify-between gap-x-6 gap-y-1"
            style={{ borderColor: "var(--color-border)" }}
          >
            <span>
              Saves to{" "}
              <code className="font-mono text-[10.5px] text-[color:var(--color-fg-dim)]">
                &lt;project&gt;/.marvin/honeycomb.json
              </code>
              , or{" "}
              <code className="font-mono text-[10.5px] text-[color:var(--color-fg-dim)]">
                ~/.marvin/
              </code>{" "}
              if no project is active.
            </span>
            <span>
              Models, theme, permissions, project — in the top bar.
            </span>
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
