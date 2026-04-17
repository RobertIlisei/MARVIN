"use client";

import { useEffect, useMemo, useState } from "react";

export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};

type TreeResponse = {
  root: string;
  tree: TreeNode[];
  truncated: boolean;
  count: number;
};

type StatusResponse = {
  isGit: boolean;
  branch?: string | null;
  status: Record<string, string>;
};

type StatusCtx = {
  status: Record<string, string>;
  /** Dir paths that contain at least one modified descendant. */
  dirtyDirs: Set<string>;
};

const EMPTY_STATUS_CTX: StatusCtx = {
  status: {},
  dirtyDirs: new Set(),
};

export function FileTree({
  cwd,
  onSelect,
  selectedPath,
}: {
  cwd: string;
  onSelect?: (path: string) => void;
  selectedPath?: string;
}) {
  const [data, setData] = useState<TreeResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setData(null);
      setStatus(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/files/tree?cwd=${encodeURIComponent(cwd)}`).then(
        async (r) => {
          if (!r.ok) {
            const body = (await r.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? r.statusText);
          }
          return (await r.json()) as TreeResponse;
        },
      ),
      fetch(`/api/files/status?cwd=${encodeURIComponent(cwd)}`)
        .then((r) => (r.ok ? r.json() : { isGit: false, status: {} }))
        .catch(() => ({ isGit: false, status: {} })) as Promise<StatusResponse>,
    ])
      .then(([tree, st]) => {
        if (cancelled) return;
        setData(tree);
        setStatus(st);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Build the "dirty ancestors" set so directory nodes can show a marker
  // when anything inside them is modified.
  const ctx: StatusCtx = useMemo(() => {
    if (!status || !status.isGit) return EMPTY_STATUS_CTX;
    const dirty = new Set<string>();
    for (const p of Object.keys(status.status)) {
      let cur = p;
      while (cur && cur !== "/" && cur.length > 1) {
        const parent = cur.replace(/\/[^/]*$/, "");
        if (!parent || parent === cur) break;
        dirty.add(parent);
        cur = parent;
      }
    }
    return { status: status.status, dirtyDirs: dirty };
  }, [status]);

  if (!cwd) {
    return (
      <div className="p-4 text-xs text-[color:var(--color-fg-faint)]">
        pick a project directory to browse.
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div className="p-4 text-xs text-[color:var(--color-fg-dim)]">
        reading tree…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4 text-xs text-[color:var(--color-danger)]/80">
        {error}
      </div>
    );
  }
  if (!data) return null;

  const rootName =
    data.root.split("/").filter(Boolean).slice(-1)[0] ?? data.root;

  return (
    <div className="scroll-thin h-full overflow-y-auto p-2 font-mono text-[12px]">
      <div className="mb-2 flex items-center gap-2 truncate px-1 text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
        <span className="truncate">{rootName}</span>
        {status?.isGit && status.branch && (
          <span className="ml-auto shrink-0 rounded border border-[color:var(--color-border)] px-1 py-[1px] text-[9px] normal-case tracking-normal text-[color:var(--color-fg-dim)]">
            {status.branch}
          </span>
        )}
      </div>
      <TreeList
        nodes={data.tree}
        depth={0}
        ctx={ctx}
        {...(onSelect ? { onSelect } : {})}
        {...(selectedPath ? { selectedPath } : {})}
      />
      {data.truncated && (
        <div className="mt-3 border-t border-[color:var(--color-border)] px-1 pt-2 text-[10px] text-[color:var(--color-fg-faint)]">
          tree truncated at {data.count} entries
        </div>
      )}
    </div>
  );
}

function TreeList({
  nodes,
  depth,
  ctx,
  onSelect,
  selectedPath,
}: {
  nodes: TreeNode[];
  depth: number;
  ctx: StatusCtx;
  onSelect?: (path: string) => void;
  selectedPath?: string;
}) {
  return (
    <ul className="flex flex-col">
      {nodes.map((n) => (
        <TreeItem
          key={n.path}
          node={n}
          depth={depth}
          ctx={ctx}
          {...(onSelect ? { onSelect } : {})}
          {...(selectedPath ? { selectedPath } : {})}
        />
      ))}
    </ul>
  );
}

function badgeFor(code: string): { label: string; className: string } | null {
  if (!code) return null;
  if (code === "??")
    return {
      label: "?",
      className: "text-[color:var(--color-warn)]",
    };
  if (code.includes("D"))
    return {
      label: "D",
      className: "text-[color:var(--color-danger)]",
    };
  if (code.includes("A"))
    return {
      label: "A",
      className: "text-[color:var(--color-success)]",
    };
  if (code.includes("M"))
    return {
      label: "M",
      className: "text-[color:var(--color-accent)]",
    };
  if (code.includes("R"))
    return {
      label: "R",
      className: "text-[color:var(--color-accent-deep)]",
    };
  return { label: code.trim() || "•", className: "text-[color:var(--color-fg-dim)]" };
}

function TreeItem({
  node,
  depth,
  ctx,
  onSelect,
  selectedPath,
}: {
  node: TreeNode;
  depth: number;
  ctx: StatusCtx;
  onSelect?: (path: string) => void;
  selectedPath?: string;
}) {
  const [open, setOpen] = useState(depth < 1);
  const padding = 6 + depth * 10;

  if (node.type === "dir") {
    const empty = !node.children || node.children.length === 0;
    const dirty = ctx.dirtyDirs.has(node.path);
    return (
      <li>
        <button
          type="button"
          onClick={() => !empty && setOpen((v) => !v)}
          disabled={empty}
          className="flex w-full items-center gap-1 rounded px-1 py-[2px] text-left text-[color:var(--color-fg)]/90 transition hover:bg-[color:var(--color-bg-elev)]/60 disabled:opacity-40"
          style={{ paddingLeft: padding }}
        >
          <span className="w-3 text-center text-[10px] text-[color:var(--color-fg-faint)]">
            {empty ? "·" : open ? "▾" : "▸"}
          </span>
          <span className="truncate text-[color:var(--color-accent)]/90">
            {node.name}
          </span>
          {dirty && (
            <span
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]"
              aria-label="modified"
            />
          )}
        </button>
        {open && node.children && node.children.length > 0 && (
          <TreeList
            nodes={node.children}
            depth={depth + 1}
            ctx={ctx}
            {...(onSelect ? { onSelect } : {})}
            {...(selectedPath ? { selectedPath } : {})}
          />
        )}
      </li>
    );
  }

  const selected = selectedPath === node.path;
  const code = ctx.status[node.path];
  const badge = code ? badgeFor(code) : null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect?.(node.path)}
        className={`flex w-full items-center gap-1 rounded px-1 py-[2px] text-left transition hover:bg-[color:var(--color-bg-elev)]/60 ${
          selected
            ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-fg)]"
            : "text-[color:var(--color-fg-dim)]"
        }`}
        style={{ paddingLeft: padding + 14 }}
      >
        <span className="truncate">{node.name}</span>
        {badge && (
          <span
            className={`ml-auto shrink-0 font-mono text-[10px] ${badge.className}`}
          >
            {badge.label}
          </span>
        )}
      </button>
    </li>
  );
}
