"use client";

import { useEffect, useState } from "react";

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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/files/tree?cwd=${encodeURIComponent(cwd)}`)
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? r.statusText);
        }
        return (await r.json()) as TreeResponse;
      })
      .then((d) => {
        if (!cancelled) setData(d);
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

  const rootName = data.root.split("/").filter(Boolean).slice(-1)[0] ?? data.root;

  return (
    <div className="scroll-thin h-full overflow-y-auto p-2 font-mono text-[12px]">
      <div className="mb-2 truncate px-1 text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
        {rootName}
      </div>
      <TreeList
        nodes={data.tree}
        depth={0}
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
  onSelect,
  selectedPath,
}: {
  nodes: TreeNode[];
  depth: number;
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
          {...(onSelect ? { onSelect } : {})}
          {...(selectedPath ? { selectedPath } : {})}
        />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  depth,
  onSelect,
  selectedPath,
}: {
  node: TreeNode;
  depth: number;
  onSelect?: (path: string) => void;
  selectedPath?: string;
}) {
  const [open, setOpen] = useState(depth < 1);
  const padding = 6 + depth * 10;

  if (node.type === "dir") {
    const empty = !node.children || node.children.length === 0;
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
        </button>
        {open && node.children && node.children.length > 0 && (
          <TreeList
            nodes={node.children}
            depth={depth + 1}
            {...(onSelect ? { onSelect } : {})}
            {...(selectedPath ? { selectedPath } : {})}
          />
        )}
      </li>
    );
  }

  const selected = selectedPath === node.path;
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
      </button>
    </li>
  );
}
