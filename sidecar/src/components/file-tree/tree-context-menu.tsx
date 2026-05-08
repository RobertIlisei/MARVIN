"use client";

/**
 * Right-click menu for a file-tree row. Dispatches actions via callbacks
 * provided by the parent so the menu stays pure — the parent owns state
 * (selection, mutations, rename/pending-new).
 *
 * Items rendered are conditional on whether the target is a file vs dir
 * and on how many items are currently selected (bulk vs single mode).
 */

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@marvin/ui/context-menu";
import type { ReactNode } from "react";

export interface TreeContextMenuActions {
  newFile(parentDir: string): void;
  newFolder(parentDir: string): void;
  rename(path: string): void;
  duplicate(path: string): void;
  moveToTrash(paths: string[]): void;
  deletePermanently(paths: string[]): void;
  copyPath(path: string): void;
  revealInFinder(path: string): void;
  openInTerminal(dir: string): void;
}

export function TreeContextMenu({
  node,
  selectedPaths,
  actions,
  children,
}: {
  node: { path: string; type: "file" | "dir"; parentPath: string };
  selectedPaths: string[];
  actions: TreeContextMenuActions;
  children: ReactNode;
}) {
  const multi = selectedPaths.length > 1 && selectedPaths.includes(node.path);
  const targets = multi ? selectedPaths : [node.path];
  const parentDir = node.type === "dir" ? node.path : node.parentPath;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {!multi && (
          <>
            <ContextMenuItem onSelect={() => actions.newFile(parentDir)}>
              New file
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.newFolder(parentDir)}>
              New folder
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {!multi && (
          <>
            <ContextMenuItem onSelect={() => actions.rename(node.path)}>
              Rename
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.duplicate(node.path)}>
              Duplicate
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem onSelect={() => actions.moveToTrash(targets)}>
          Move to Trash
          <ContextMenuShortcut>⌘⌫</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem
          variant="destructive"
          onSelect={() => actions.deletePermanently(targets)}
        >
          Delete permanently
          <ContextMenuShortcut>⌘⇧⌫</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        {!multi && (
          <>
            <ContextMenuItem onSelect={() => actions.copyPath(node.path)}>
              Copy path
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => actions.revealInFinder(node.path)}>
              Reveal in Finder
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                actions.openInTerminal(
                  node.type === "dir" ? node.path : node.parentPath,
                )
              }
            >
              Open in Terminal
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
