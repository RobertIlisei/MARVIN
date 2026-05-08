"use client";

/**
 * Branch dropdown: lists local branches, highlights the current,
 * switches on click. Includes a "+ new branch" action that prompts
 * inline for a name and creates + switches.
 *
 * Switch-on-dirty is denied server-side (ADR-0012 v1 rule). The
 * client surfaces that deny as a friendly inline error rather than
 * pre-checking — server-side is authoritative.
 *
 * See [ADR-0012](../../../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvin/ui/dropdown-menu";
import { useCallback, useEffect, useRef, useState } from "react";

interface BranchEntry {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

interface BranchSwitcherProps {
  cwd: string;
  currentBranch: string | null;
  onSwitch(name: string): Promise<boolean>;
  onCreate(name: string, from?: string): Promise<boolean>;
}

export function BranchSwitcher({
  cwd,
  currentBranch,
  onSwitch,
  onCreate,
}: BranchSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<BranchEntry[] | null>(null);
  // Remote-only branch names (no local counterpart). Presented below
  // the locals so the user can check them out — clicking one fires
  // `onSwitch(stripped)` which the server resolves via `git switch
  // <name>`'s DWIM (create a local tracking branch from origin if
  // needed). Users with a freshly cloned repo often have only `main`
  // as a local branch while origin has 20+ — without this section
  // the switcher feels broken even though the server is returning
  // the full list.
  const [remoteOnly, setRemoteOnly] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const createInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    const res = await fetch(`/api/git/branch?cwd=${encodeURIComponent(cwd)}`, {
      cache: "no-store",
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!body?.enabled) return;
    const locals = (body.locals ?? []) as BranchEntry[];
    const remotes = (body.remotes ?? []) as string[];
    setBranches(locals);

    // Derive remote-only names. Drop:
    //   - origin/HEAD (symbolic ref, not a real branch)
    //   - any remote whose short name already exists locally
    // Short-name form so clicking surfaces the same identifier the
    // user would type in a terminal (`git switch foo`).
    const localShortNames = new Set(locals.map((b) => b.name));
    const shortNames = new Set<string>();
    for (const r of remotes) {
      // "origin/foo" → "foo". "upstream/feature/x" → "feature/x" is
      // a tiny remote namespacing quirk; in practice MARVIN users
      // have one remote ("origin") so the simple slice works.
      const slash = r.indexOf("/");
      if (slash < 0) continue;
      const name = r.slice(slash + 1);
      if (name === "HEAD" || !name) continue;
      if (localShortNames.has(name)) continue;
      shortNames.add(name);
    }
    setRemoteOnly(Array.from(shortNames).sort());
  }, [cwd]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (creating) {
      requestAnimationFrame(() => createInputRef.current?.focus());
    } else {
      setNewName("");
    }
  }, [creating]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-fg-faint)] transition hover:bg-[color:var(--color-bg-elev)]/60 hover:text-[color:var(--color-fg)]"
          aria-label="switch branch"
        >
          ⌄
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
          branches
        </DropdownMenuLabel>
        {branches === null ? (
          <div className="px-2 py-1 font-mono text-[11px] italic text-[color:var(--color-fg-faint)]">
            loading…
          </div>
        ) : branches.length === 0 ? (
          <div className="px-2 py-1 font-mono text-[11px] italic text-[color:var(--color-fg-faint)]">
            no local branches
          </div>
        ) : (
          // Scrollable branch list — repos with lots of local branches
          // would otherwise either overflow the dropdown surface (if
          // max-h were absent) or silently trust the Radix
          // `--radix-dropdown-menu-content-available-height` cap. The
          // Radix var gets cramped on short viewports and only yields
          // a handful of visible items. Explicit 280 px (≈ 11 items)
          // with `overflow-y-auto` guarantees a predictable switcher
          // UX regardless of how much vertical space is available.
          <div className="scroll-thin max-h-[280px] overflow-y-auto">
            {branches.map((b) => (
              <DropdownMenuItem
                key={b.name}
                disabled={b.isCurrent}
                onClick={async () => {
                  setOpen(false);
                  await onSwitch(b.name);
                }}
                className="flex items-center justify-between gap-2 font-mono text-[11.5px]"
              >
                <span className="flex items-center gap-1.5 truncate">
                  <span
                    className={
                      b.isCurrent
                        ? "text-[color:var(--color-accent-deep)]"
                        : "text-[color:var(--color-fg-faint)]"
                    }
                  >
                    {b.isCurrent ? "●" : "○"}
                  </span>
                  <span className="truncate">{b.name}</span>
                </span>
                {b.upstream && (b.ahead !== null || b.behind !== null) && (
                  <span className="shrink-0 text-[10px] text-[color:var(--color-fg-faint)]">
                    {b.ahead ? `↑${b.ahead}` : ""}
                    {b.behind ? `↓${b.behind}` : ""}
                  </span>
                )}
              </DropdownMenuItem>
            ))}
          </div>
        )}
        {remoteOnly.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)]">
              remote (checkout)
            </DropdownMenuLabel>
            <div className="scroll-thin max-h-[200px] overflow-y-auto">
              {remoteOnly.map((name) => (
                <DropdownMenuItem
                  key={`remote:${name}`}
                  onClick={async () => {
                    setOpen(false);
                    // `git switch <name>` with no local match DWIMs a
                    // tracking branch from origin. Handled server-side
                    // in /api/git/branch/switch.
                    await onSwitch(name);
                  }}
                  className="flex items-center gap-1.5 truncate font-mono text-[11.5px] text-[color:var(--color-fg-dim)]"
                >
                  <span className="text-[color:var(--color-fg-faint)]">↓</span>
                  <span className="truncate">{name}</span>
                </DropdownMenuItem>
              ))}
            </div>
          </>
        )}
        <DropdownMenuSeparator />
        {creating ? (
          <form
            className="flex items-center gap-1.5 px-2 py-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const trimmed = newName.trim();
              if (!trimmed) return;
              const ok = await onCreate(trimmed, currentBranch ?? undefined);
              if (ok) {
                setCreating(false);
                await onSwitch(trimmed);
                setOpen(false);
              }
            }}
          >
            <input
              ref={createInputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCreating(false);
                }
              }}
              placeholder={
                currentBranch ? `new-branch (from ${currentBranch})` : "new-branch"
              }
              className="w-full rounded-[3px] border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--color-fg)] focus:border-[color:var(--color-accent-deep)] focus:outline-none"
            />
          </form>
        ) : (
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              setCreating(true);
            }}
            className="font-mono text-[11.5px] text-[color:var(--color-fg-dim)]"
          >
            + new branch…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
