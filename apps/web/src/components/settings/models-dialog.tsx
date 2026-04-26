"use client";

/**
 * Models dialog — dedicated home for the executor + advisor picker.
 *
 * Pre-fix the picker lived inline inside the Setup popover. That
 * popover renders inside a Radix DropdownMenuContent which inherits
 * `max-h: --radix-dropdown-menu-content-available-height` — when the
 * Tauri window is short, the picker (with its preset cards + two
 * model selects) overflowed the popover and the user reported
 * scroll juggling that didn't reveal everything. The picker has 600+
 * px of natural height; a popover is the wrong container.
 *
 * Settings is intentionally scoped to "Honeycomb only" (see memory
 * note: `marvin_settings_scope.md`), so models gets its own dialog
 * here rather than another tab in Settings.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@marvin/ui/dialog";

import { ModelPicker } from "./model-picker";

export interface ModelsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  executor: string | null;
  advisor: string | null;
  onChange(v: { executor: string | null; advisor: string | null }): void;
}

export function ModelsDialog({
  open,
  onOpenChange,
  executor,
  advisor,
  onChange,
}: ModelsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Same width target as Settings so the two dialogs feel
        // alike, but `p-0` so the panel paints its own padding and
        // the close-X sits inside our header row.
        className="sm:max-w-2xl p-0 overflow-hidden"
        // Same Tauri drag-region stop-propagation guard the Settings
        // dialog uses — without it, a click on the trigger inside
        // `data-tauri-drag-region` propagates to the document and
        // dismisses the dialog in the same tick.
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
        <div className="flex flex-col max-h-[min(85vh,40rem)]">
          <DialogHeader className="sr-only">
            <DialogTitle>Models</DialogTitle>
            <DialogDescription>
              Configure executor + advisor model slots.
            </DialogDescription>
          </DialogHeader>

          <header
            className="flex flex-col gap-1.5 px-8 pt-7 pb-5 border-b"
            style={{ borderColor: "var(--color-border)" }}
          >
            <div className="text-[10px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)]">
              marvin · setup
            </div>
            <h2 className="font-display text-[24px] leading-tight text-[color:var(--color-fg)]">
              Models
            </h2>
            <p className="text-[12.5px] leading-relaxed text-[color:var(--color-fg-dim)] max-w-prose">
              Pick a preset or override individual slots. The executor
              drives the turn loop; the advisor is optional and
              escalates the executor on hard steps via the SDK's
              advisor tool.
            </p>
          </header>

          <div className="scroll-thin overflow-y-auto px-8 py-7">
            <ModelPicker
              executor={executor}
              advisor={advisor}
              onChange={onChange}
              alwaysExpanded
            />
          </div>

          <footer
            className="px-8 py-3.5 border-t text-[11px] leading-relaxed text-[color:var(--color-fg-faint)]"
            style={{ borderColor: "var(--color-border)" }}
          >
            Reset all preferences in <strong>Settings → Reset
              preferences</strong>.
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
