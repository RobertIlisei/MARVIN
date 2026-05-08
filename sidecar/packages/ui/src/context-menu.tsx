"use client"

import { CheckIcon, ChevronRightIcon, CircleIcon } from "lucide-react"
import { ContextMenu as ContextMenuPrimitive } from "radix-ui"
import type * as React from "react"

import { cn } from "./utils"

// MARVIN token shorthand.
// Surfaces / borders / text / focus use the `@theme` variables defined in
// `apps/web/src/app/globals.css` rather than shadcn's `--popover` /
// `--accent` / `--muted-foreground` names (which MARVIN never declares —
// see ADR-0006 for the theme cascade). Keeping the MARVIN tokens inline
// here means the menu stays opaque without depending on a separate CSS
// layer.
const SURFACE =
  "border border-[color:var(--color-border-strong)] bg-[color:var(--material-popover)] text-[color:var(--color-fg)] shadow-[var(--shadow-panel)]"
const ITEM_BASE =
  "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-[color:var(--color-fg-faint)]"
const ITEM_FOCUS =
  "focus:bg-[color:var(--color-accent-glow)] focus:text-[color:var(--color-fg)]"
const ITEM_DESTRUCTIVE =
  "data-[variant=destructive]:text-[color:var(--color-danger)] data-[variant=destructive]:focus:bg-[color:var(--color-danger)]/15 data-[variant=destructive]:focus:text-[color:var(--color-danger)] data-[variant=destructive]:*:[svg]:text-[color:var(--color-danger)]!"

function ContextMenu({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return (
    <ContextMenuPrimitive.Trigger
      data-slot="context-menu-trigger"
      {...props}
    />
  )
}

function ContextMenuContent({
  className,
  style,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        data-slot="context-menu-content"
        // Visibility forced via inline style + `data-[state=*]:animate-*`
        // classes removed. Same bug that bit Dialog (see
        // packages/ui/src/dialog.tsx root-cause debrief): Tailwind v4 +
        // Turbopack + Radix + tw-animate-css leaves the content stuck at
        // opacity:0 when the enter animation's keyframe transform
        // overrides the base centering translate. User-visible symptom:
        // right-click the file tree and the menu appears as a
        // transparent veil — overlay visible, body invisible. Dropping
        // the animate classes and forcing opacity:1 + an opaque
        // material-popover background is the reliable fix; we accept no
        // enter/leave animation on context menus for now.
        style={{
          opacity: 1,
          backgroundColor: "var(--material-popover)",
          ...style,
        }}
        className={cn(
          // A4 polish: rounded-lg (8 px) matches macOS system context
          // menus better than the previous rounded-md (6 px).
          "z-50 min-w-[12rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg p-1",
          SURFACE,
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
  return (
    <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        ITEM_BASE,
        ITEM_FOCUS,
        ITEM_DESTRUCTIVE,
        "data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      data-slot="context-menu-checkbox-item"
      className={cn(
        ITEM_BASE,
        ITEM_FOCUS,
        "py-1.5 pr-2 pl-8",
        className,
      )}
      checked={checked}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.CheckboxItem>
  )
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return (
    <ContextMenuPrimitive.RadioGroup
      data-slot="context-menu-radio-group"
      {...props}
    />
  )
}

function ContextMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(
        ITEM_BASE,
        ITEM_FOCUS,
        "py-1.5 pr-2 pl-8",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-[color:var(--color-fg-faint)] data-[inset]:pl-8",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-[color:var(--color-border)]", className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-[color:var(--color-fg-faint)]",
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSub({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        ITEM_BASE,
        ITEM_FOCUS,
        "data-[inset]:pl-8 data-[state=open]:bg-[color:var(--color-accent-glow)] data-[state=open]:text-[color:var(--color-fg)]",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-4" />
    </ContextMenuPrimitive.SubTrigger>
  )
}

function ContextMenuSubContent({
  className,
  style,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.SubContent
      data-slot="context-menu-sub-content"
      // Same animate-class drop + inline opacity/material fix as the
      // primary ContextMenuContent above.
      style={{
        opacity: 1,
        backgroundColor: "var(--material-popover)",
        ...style,
      }}
      className={cn(
        "z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-lg p-1",
        SURFACE,
        className,
      )}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
}
