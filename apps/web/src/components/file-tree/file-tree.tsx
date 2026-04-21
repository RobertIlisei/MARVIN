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

/**
 * Per-project expansion state is persisted to
 * `localStorage.marvin.fileTree.openDirs:<cwd>` so tab switches
 * (Files ⇄ Source Control) and page reloads don't collapse every
 * directory the user had open. The `<FileTree>` fully unmounts on tab
 * switch (conditional render in `page.tsx`); without persistence each
 * remount rehydrates to the default "only depth-0 open" state, which
 * is what the user reported.
 */
const LS_OPEN_DIRS_PREFIX = "marvin.fileTree.openDirs:";

/**
 * Best-effort read. Returns an empty map when nothing is stored, the
 * blob is unparseable, or localStorage is unavailable (private mode,
 * Tauri quirks, SSR).
 */
function readStoredOpenDirs(cwd: string): OpenMap {
  if (typeof window === "undefined" || !cwd) return {};
  try {
    const raw = window.localStorage.getItem(LS_OPEN_DIRS_PREFIX + cwd);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OpenMap;
    }
  } catch {
    /* ignore */
  }
  return {};
}

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
  onOpenInTerminal,
}: {
  cwd: string;
  onSelect?: (path: string) => void;
  selectedPath?: string;
  /** Toggle the terminal pane on (if off). Called before the `cd` event fires. */
  onOpenInTerminal?: () => void;
}) {
  const [data, setData] = useState<TreeResponse | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Hydrate openDirs synchronously from localStorage on first mount
  // for the current cwd. useState's lazy initializer runs once per
  // component instance — subsequent cwd changes re-hydrate via the
  // effect below. Lazy init avoids the "flash of collapsed tree"
  // on remount after a tab switch.
  const [openDirs, setOpenDirs] = useState<OpenMap>(() =>
    readStoredOpenDirs(cwd),
  );
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

  // Re-hydrate openDirs when cwd changes — switching projects should
  // load each project's own persisted expansion map. The lazy useState
  // initializer above handles first mount; this effect handles
  // subsequent cwd transitions.
  useEffect(() => {
    setOpenDirs(readStoredOpenDirs(cwd));
  }, [cwd]);

  // Persist every openDirs change. Trivial cost — the map only holds
  // paths the user has explicitly toggled, not every directory in the
  // tree. If localStorage is full / unavailable the catch swallows.
  useEffect(() => {
    if (typeof window === "undefined" || !cwd) return;
    try {
      window.localStorage.setItem(
        LS_OPEN_DIRS_PREFIX + cwd,
        JSON.stringify(openDirs),
      );
    } catch {
      /* quota / private mode — ignore */
    }
  }, [cwd, openDirs]);

  const ctx: StatusCtx = useMemo(() => {
    if (!status?.isGit) return EMPTY_STATUS_CTX;
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
      revealInFinder: async (path) => {
        try {
          await fetch("/api/files/reveal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cwd, path }),
          });
        } catch {
          /* swallow; reveal is fire-and-forget UX-wise */
        }
      },
      openInTerminal: (dir) => {
        onOpenInTerminal?.();
        // Delay the cd event so the Terminal mount effect has time to
        // attach its listener when the pane was just toggled on.
        setTimeout(() => {
          const cmd = `cd ${quoteForShell(dir)}`;
          window.dispatchEvent(
            new CustomEvent("marvin:terminal-run", { detail: { cmd } }),
          );
        }, 80);
      },
    }),
    [cwd, mutations, openDir, onOpenInTerminal],
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
  // Hue map (light + dark cross-theme):
  //   ? (untracked) → warn   (amber)
  //   D (deleted)   → danger (red)
  //   A (added)     → success (green)
  //   M (modified)  → git-modified (blue) — was --color-accent which
  //                   in light = near-black ink; invisible next to
  //                   directory-name text of the same tone.
  //   R (renamed)   → git-renamed  (purple) — same reason as M.
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
      className: "text-[color:var(--color-git-modified)]",
    };
  if (code.includes("R"))
    return {
      label: "R",
      className: "text-[color:var(--color-git-renamed)]",
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
  const { ctx, openDirs, setOpenDirs, selection, dnd, actions, mutations, pendingCreate, setPendingCreate, renaming, setRenaming, onSelect, selectedPath } = shared;
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
            // `cursor-default` (arrow, not I-beam) + `select-none`
            // make clickable rows feel like list items rather than
            // paragraphs of text. Browser default for a `<div>` over
            // text content is the I-beam; on a native-feeling IDE
            // row that reads as "you can select text here," which is
            // wrong — these are buttons in all but markup.
            className={`flex w-full cursor-default items-center gap-1 rounded px-1 py-[2px] text-left transition select-none ${
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
                role="img"
                aria-label="modified"
                className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent)]"
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
          // Same cursor-default + select-none reasoning as the dir
          // row above — this is a list item in all but markup.
          className={`flex w-full cursor-default items-center gap-1 rounded px-1 py-[2px] text-left transition select-none ${
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
              // `font-semibold` gives the single-letter badge enough
              // weight to register as a tag against the dim row text
              // at 10 px. Without it the hue is correct but reads as
              // just another dimly coloured character in a monospace
              // line, not a status marker.
              className={`ml-auto shrink-0 font-mono text-[10px] font-semibold ${badge.className}`}
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

/**
 * Wrap a path in single-quotes for a POSIX shell. Embedded single-quotes
 * are escaped via the standard `'\''` dance. Avoids a shell-injection
 * footgun if a path contains spaces, `$`, or other metacharacters.
 */
function quoteForShell(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
