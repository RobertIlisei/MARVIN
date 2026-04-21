"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ConfirmDeleteDialog, type ConfirmDeleteDialogState } from "./confirm-delete-dialog";
import { InlineRename } from "./inline-rename";
import { TreeContextMenu, type TreeContextMenuActions } from "./tree-context-menu";
import {
  UploadProgressToast,
  type UploadToastState,
} from "./upload-progress-toast";
import { useFsMutations } from "./use-fs-mutations";
import { useOsDrop } from "./use-os-drop";
import { useTreeDnd } from "./use-tree-dnd";
import { useTreeSelection } from "./use-tree-selection";

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

type OpenMap = Record<string, boolean>;

/** Transient state: new file/dir placeholder row awaiting a name. */
type PendingCreate = { parent: string; kind: "file" | "dir" } | null;
/** Transient state: row currently in rename mode. */
type RenamingPath = string | null;

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
  const [refreshTick, setRefreshTick] = useState(0);
  const [openDirs, setOpenDirs] = useState<OpenMap>({});
  const [pendingCreate, setPendingCreate] = useState<PendingCreate>(null);
  const [renaming, setRenaming] = useState<RenamingPath>(null);
  const [confirmState, setConfirmState] = useState<ConfirmDeleteDialogState & {
    onResolve?: (approved: boolean) => void;
  }>({ open: false, reason: "", severity: "warn", summary: "" });
  const [uploadToast, setUploadToast] = useState<UploadToastState>({
    result: null,
    error: null,
    uploading: false,
  });

  // Fetch + revalidation --------------------------------------------------
  const revalidate = useCallback(() => setRefreshTick((t) => t + 1), []);

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
  }, [cwd, refreshTick]);

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

  // Flatten the visible tree so selection + keyboard-range arithmetic works.
  const visibleOrder = useMemo(
    () => (data ? flattenVisible(data.tree, openDirs) : []),
    [data, openDirs],
  );

  const selection = useTreeSelection({ visibleOrder });

  // Mutations + DnD -------------------------------------------------------
  const requestConfirm = useCallback(
    async (req: {
      reason: string;
      severity: "warn" | "danger";
      summary: string;
    }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        setConfirmState({
          open: true,
          reason: req.reason,
          severity: req.severity,
          summary: req.summary,
          onResolve: resolve,
        });
      }),
    [],
  );

  const mutations = useFsMutations({
    cwd,
    onConfirm: requestConfirm,
    onRevalidate: revalidate,
  });

  const dnd = useTreeDnd({
    onMove: async ({ from, to }) => {
      await mutations.move(from, to);
    },
  });

  const osDrop = useOsDrop({
    cwd,
    onComplete: (result) => {
      setUploadToast({ result, error: null, uploading: false });
      revalidate();
    },
    onError: (message) => {
      setUploadToast({ result: null, error: message, uploading: false });
    },
  });

  // Keep the toast's `uploading` flag live with the hook.
  useEffect(() => {
    setUploadToast((s) =>
      s.uploading === osDrop.uploading ? s : { ...s, uploading: osDrop.uploading },
    );
  }, [osDrop.uploading]);

  // Action handlers -------------------------------------------------------
  const openDir = useCallback((p: string) => {
    setOpenDirs((m) => ({ ...m, [p]: true }));
  }, []);

  const actions: TreeContextMenuActions = useMemo(
    () => ({
      newFile: (parent) => {
        openDir(parent);
        setPendingCreate({ parent, kind: "file" });
      },
      newFolder: (parent) => {
        openDir(parent);
        setPendingCreate({ parent, kind: "dir" });
      },
      rename: (path) => {
        setRenaming(path);
      },
      duplicate: async (path) => {
        const dot = path.lastIndexOf(".");
        const slash = path.lastIndexOf("/");
        const dup =
          dot > slash
            ? `${path.slice(0, dot)}-copy${path.slice(dot)}`
            : `${path}-copy`;
        // Try cheap content-copy via create — server rejects oversize.
        const read = await fetch(
          `/api/files/content?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
        );
        if (!read.ok) return;
        const body = (await read.json()) as {
          content?: string;
          binary?: boolean;
          truncated?: boolean;
        };
        if (body.binary || body.truncated) return;
        await mutations.createFile(dup, body.content ?? "", false);
      },
      moveToTrash: async (paths) => {
        await mutations.del(paths, "trash");
      },
      deletePermanently: async (paths) => {
        await mutations.del(paths, "permanent");
      },
      copyPath: (path) => {
        navigator.clipboard?.writeText(path).catch(() => undefined);
      },
      // M6 items — noop for now but wired so the menu item can exist.
      revealInFinder: () => undefined,
      openInTerminal: () => undefined,
    }),
    [cwd, mutations, openDir],
  );

  // Keyboard shortcuts (on the tree root)
  const onRootKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const sel = Array.from(selection.selected);
      if (sel.length === 0) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
        e.preventDefault();
        if (e.shiftKey) actions.deletePermanently(sel);
        else actions.moveToTrash(sel);
      } else if (e.key === "F2" && sel.length === 1 && sel[0]) {
        e.preventDefault();
        actions.rename(sel[0]);
      } else if (e.key === "Escape") {
        selection.clear();
      }
    },
    [actions, selection],
  );

  // Render ---------------------------------------------------------------
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
    <div
      className={`scroll-thin h-full overflow-y-auto p-2 font-mono text-[12px] ${
        osDrop.osDragHover
          ? "outline outline-2 outline-[color:var(--color-accent)]/70"
          : ""
      }`}
      tabIndex={-1}
      onKeyDown={onRootKeyDown}
      {...osDrop.osDropProps({ destDir: data.root })}
    >
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
        openDirs={openDirs}
        setOpenDirs={setOpenDirs}
        selection={selection}
        dnd={dnd}
        actions={actions}
        mutations={mutations}
        cwd={cwd}
        pendingCreate={pendingCreate}
        setPendingCreate={setPendingCreate}
        renaming={renaming}
        setRenaming={setRenaming}
        {...(onSelect ? { onSelect } : {})}
        {...(selectedPath ? { selectedPath } : {})}
      />
      {data.truncated && (
        <div className="mt-3 border-t border-[color:var(--color-border)] px-1 pt-2 text-[10px] text-[color:var(--color-fg-faint)]">
          tree truncated at {data.count} entries
        </div>
      )}
      <ConfirmDeleteDialog
        state={confirmState}
        onCancel={() => {
          confirmState.onResolve?.(false);
          setConfirmState((s) => ({ ...s, open: false }));
        }}
        onConfirm={() => {
          confirmState.onResolve?.(true);
          setConfirmState((s) => ({ ...s, open: false }));
        }}
      />
      <UploadProgressToast
        state={uploadToast}
        onDismiss={() =>
          setUploadToast({ result: null, error: null, uploading: false })
        }
      />
    </div>
  );
}

interface SharedProps {
  ctx: StatusCtx;
  openDirs: OpenMap;
  setOpenDirs: (u: (m: OpenMap) => OpenMap) => void;
  selection: ReturnType<typeof useTreeSelection>;
  dnd: ReturnType<typeof useTreeDnd>;
  actions: TreeContextMenuActions;
  mutations: ReturnType<typeof useFsMutations>;
  cwd: string;
  pendingCreate: PendingCreate;
  setPendingCreate: (v: PendingCreate) => void;
  renaming: RenamingPath;
  setRenaming: (v: RenamingPath) => void;
  onSelect?: (path: string) => void;
  selectedPath?: string;
}

function TreeList({
  nodes,
  depth,
  ...shared
}: {
  nodes: TreeNode[];
  depth: number;
} & SharedProps) {
  return (
    <ul className="flex flex-col">
      {nodes.map((n) => (
        <TreeItem key={n.path} node={n} depth={depth} {...shared} />
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
  ...shared
}: {
  node: TreeNode;
  depth: number;
} & SharedProps) {
  const { ctx, openDirs, setOpenDirs, selection, dnd, actions, mutations, cwd, pendingCreate, setPendingCreate, renaming, setRenaming, onSelect, selectedPath } = shared;
  const padding = 6 + depth * 10;
  const isRenaming = renaming === node.path;
  const parentPath = parentOf(node.path);

  if (node.type === "dir") {
    const empty = !node.children || node.children.length === 0;
    const dirty = ctx.dirtyDirs.has(node.path);
    const open = openDirs[node.path] ?? depth < 1;
    const selected = selection.isSelected(node.path);
    const dropHover = dnd.dropTarget === node.path;
    const isPendingParent = pendingCreate?.parent === node.path;
    return (
      <li>
        <TreeContextMenu
          node={{ path: node.path, type: "dir", parentPath }}
          selectedPaths={Array.from(selection.selected)}
          actions={actions}
        >
          <div
            className={`flex w-full items-center gap-1 rounded px-1 py-[2px] text-left transition ${
              selected
                ? "bg-[color:var(--color-accent-glow)]"
                : "hover:bg-[color:var(--color-bg-elev)]/60"
            } ${
              dropHover
                ? "outline outline-1 outline-[color:var(--color-accent)]"
                : ""
            }`}
            style={{ paddingLeft: padding }}
            onClick={(e) => {
              selection.onItemClick(node.path, e);
              if (!empty && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                setOpenDirs((m) => ({ ...m, [node.path]: !open }));
              }
            }}
            {...(isRenaming ? {} : dnd.dragProps({ path: node.path, selected: selection.selected }))}
            {...dnd.dropProps({ path: node.path })}
          >
            <span className="w-3 text-center text-[10px] text-[color:var(--color-fg-faint)]">
              {empty ? "·" : open ? "▾" : "▸"}
            </span>
            {isRenaming ? (
              <InlineRename
                initial={node.name}
                paddingLeft={0}
                onCancel={() => setRenaming(null)}
                onCommit={async (newName) => {
                  const to = joinName(node.path, newName);
                  await mutations.rename(node.path, to);
                  setRenaming(null);
                }}
              />
            ) : (
              <span className="truncate text-[color:var(--color-accent)]/90">
                {node.name}
              </span>
            )}
            {dirty && !isRenaming && (
              <span
                className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]"
                aria-label="modified"
              />
            )}
          </div>
        </TreeContextMenu>
        {open && (
          <>
            {isPendingParent && pendingCreate && (
              <PendingCreateRow
                depth={depth + 1}
                kind={pendingCreate.kind}
                onCancel={() => setPendingCreate(null)}
                onCommit={async (name) => {
                  const newPath = joinName(node.path, name);
                  if (pendingCreate.kind === "file") {
                    await mutations.createFile(newPath, "", false);
                  } else {
                    await mutations.createDir(newPath);
                  }
                  setPendingCreate(null);
                }}
              />
            )}
            {node.children && node.children.length > 0 && (
              <TreeList nodes={node.children} depth={depth + 1} {...shared} />
            )}
          </>
        )}
      </li>
    );
  }

  const selected = selectedPath === node.path || selection.isSelected(node.path);
  const code = ctx.status[node.path];
  const badge = code ? badgeFor(code) : null;
  return (
    <li>
      <TreeContextMenu
        node={{ path: node.path, type: "file", parentPath }}
        selectedPaths={Array.from(selection.selected)}
        actions={actions}
      >
        <div
          className={`flex w-full items-center gap-1 rounded px-1 py-[2px] text-left transition ${
            selected
              ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-fg)]"
              : "text-[color:var(--color-fg-dim)] hover:bg-[color:var(--color-bg-elev)]/60"
          }`}
          style={{ paddingLeft: padding + 14 }}
          onClick={(e) => {
            selection.onItemClick(node.path, e);
            if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
              onSelect?.(node.path);
            }
          }}
          {...(isRenaming ? {} : dnd.dragProps({ path: node.path, selected: selection.selected }))}
        >
          {isRenaming ? (
            <InlineRename
              initial={node.name}
              paddingLeft={0}
              onCancel={() => setRenaming(null)}
              onCommit={async (newName) => {
                const to = joinName(node.path, newName);
                await mutations.rename(node.path, to);
                setRenaming(null);
              }}
            />
          ) : (
            <span className="truncate">{node.name}</span>
          )}
          {badge && !isRenaming && (
            <span
              className={`ml-auto shrink-0 font-mono text-[10px] ${badge.className}`}
            >
              {badge.label}
            </span>
          )}
        </div>
      </TreeContextMenu>
    </li>
  );
}

function PendingCreateRow({
  depth,
  kind,
  onCancel,
  onCommit,
}: {
  depth: number;
  kind: "file" | "dir";
  onCancel(): void;
  onCommit(name: string): void;
}) {
  const padding = 6 + depth * 10;
  return (
    <div
      className="flex w-full items-center gap-1 rounded px-1 py-[2px]"
      style={{ paddingLeft: padding }}
    >
      <span className="w-3 text-center text-[10px] text-[color:var(--color-fg-faint)]">
        {kind === "dir" ? "▸" : " "}
      </span>
      <InlineRename
        initial={kind === "dir" ? "new-folder" : "untitled.txt"}
        paddingLeft={0}
        onCancel={onCancel}
        onCommit={onCommit}
      />
    </div>
  );
}

function flattenVisible(tree: TreeNode[], openDirs: OpenMap): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push(n.path);
      if (n.type === "dir" && (openDirs[n.path] ?? depth < 1) && n.children) {
        walk(n.children, depth + 1);
      }
    }
  };
  walk(tree, 0);
  return out;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

function joinName(parentOrOldPath: string, name: string): string {
  const i = parentOrOldPath.lastIndexOf("/");
  const parent = i > 0 ? parentOrOldPath.slice(0, i) : parentOrOldPath;
  return `${parent}/${name}`;
}
