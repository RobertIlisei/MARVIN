"use client";

/**
 * Remote-ops row: Fetch / Pull / Push buttons.
 *
 * Placed below the BranchBar. Each button fires its mutation and
 * relies on the existing `use-git-mutations` pipeline — so
 * confirm-class strategies (pull --rebase, push --force-with-lease)
 * surface through the same `ConfirmGitOpDialog` as local ops.
 *
 * Pull defaults to `ff-only` (auto-class). The ▾ split next to Pull
 * exposes `--rebase` + `--merge` strategies. Push defaults to a
 * regular push; the ▾ split exposes `--force-with-lease`. Plain
 * `--force` is never available from the panel — ADR-0012.
 *
 * See [ADR-0013](../../../../../docs/decisions/0013-git-remote-ops-and-credentials.md).
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@marvin/ui/dropdown-menu";

export interface RemoteBarProps {
  hasUpstream: boolean;
  busy: boolean;
  onFetch(): Promise<boolean>;
  onPull(strategy: "ff-only" | "rebase" | "merge"): Promise<boolean>;
  onPush(forceWithLease: boolean): Promise<boolean>;
}

export function RemoteBar({
  hasUpstream,
  busy,
  onFetch,
  onPull,
  onPush,
}: RemoteBarProps) {
  return (
    <div className="flex items-center gap-1 border-b border-[color:var(--color-border)] px-3 py-1.5">
      <RemoteButton
        label="fetch"
        title="git fetch origin"
        disabled={busy}
        onClick={() => void onFetch()}
      />
      <SplitButton
        mainLabel="pull"
        mainTitle={
          hasUpstream
            ? "git pull --ff-only"
            : "no upstream — set one via the terminal"
        }
        mainDisabled={busy || !hasUpstream}
        onMainClick={() => void onPull("ff-only")}
        menu={[
          {
            label: "pull --rebase",
            title: "rebase local commits on upstream",
            disabled: busy || !hasUpstream,
            onClick: () => void onPull("rebase"),
          },
          {
            label: "pull --merge",
            title: "create a merge commit",
            disabled: busy || !hasUpstream,
            onClick: () => void onPull("merge"),
          },
        ]}
      />
      <SplitButton
        mainLabel="push"
        mainTitle={
          hasUpstream
            ? "git push origin <branch>"
            : "no upstream — set one via the terminal"
        }
        mainDisabled={busy || !hasUpstream}
        onMainClick={() => void onPush(false)}
        menu={[
          {
            label: "push --force-with-lease",
            title: "rewrite remote branch if lease matches",
            danger: true,
            disabled: busy || !hasUpstream,
            onClick: () => void onPush(true),
          },
        ]}
      />
    </div>
  );
}

function RemoteButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className="rounded-[3px] border border-[color:var(--color-border)] px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-accent-deep)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function SplitButton({
  mainLabel,
  mainTitle,
  mainDisabled,
  onMainClick,
  menu,
}: {
  mainLabel: string;
  mainTitle: string;
  mainDisabled: boolean;
  onMainClick(): void;
  menu: Array<{
    label: string;
    title: string;
    danger?: boolean;
    disabled?: boolean;
    onClick(): void;
  }>;
}) {
  return (
    <div className="flex overflow-hidden rounded-[3px] border border-[color:var(--color-border)]">
      <button
        type="button"
        disabled={mainDisabled}
        onClick={onMainClick}
        title={mainTitle}
        className="px-2 py-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-[color:var(--color-fg-dim)] transition hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {mainLabel}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${mainLabel} options`}
            className="border-l border-[color:var(--color-border)] px-1 py-1 font-mono text-[10px] text-[color:var(--color-fg-faint)] transition hover:text-[color:var(--color-fg)]"
          >
            ▾
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {menu.map((item) => (
            <DropdownMenuItem
              key={item.label}
              disabled={item.disabled}
              onClick={item.onClick}
              title={item.title}
              className={`font-mono text-[11.5px] ${
                item.danger ? "text-[color:var(--color-danger)]" : ""
              }`}
            >
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
