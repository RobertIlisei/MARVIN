import type { TreeNode } from "./tree-node";

/**
 * Walk the tree once collecting:
 *   - `visiblePaths` — every node that should render under the filter.
 *     A node is visible if its own name matches, or if any descendant
 *     (for dirs) matches — so the ancestor chain stays intact.
 *   - `forceOpenDirs` — every dir whose subtree contains a match.
 *     These get merged into the effective openDirs so results are
 *     visible without the user manually expanding.
 *
 * Match is case-insensitive substring on `node.name`. This matches the
 * basename only, not the full path — typing "monaco" finds
 * `monaco-editor.tsx` without requiring the full `file-viewer/monaco…`
 * prefix. A dir whose name matches also keeps its entire subtree
 * visible (so typing "brain" shows everything under `brain/`), which
 * mirrors VS Code's filter behaviour.
 *
 * Lives in a `.ts` rather than colocated with the component so Vitest
 * can import it without a JSX-capable plugin. Pure function — no DOM,
 * no React.
 */
export function computeFilterMatches(
  tree: TreeNode[],
  query: string,
): { visiblePaths: Set<string>; forceOpenDirs: Set<string> } {
  const q = query.toLowerCase();
  const visiblePaths = new Set<string>();
  const forceOpenDirs = new Set<string>();
  /**
   * Returns true when `node` or any descendant matches. Side effects
   * populate the two sets. `parentMatched` (inherited from an ancestor
   * whose name matched) forces the whole subtree visible without
   * requiring each descendant to match individually.
   */
  const walk = (node: TreeNode, parentMatched: boolean): boolean => {
    const selfMatches = node.name.toLowerCase().includes(q);
    let subtreeHas = false;
    if (node.type === "dir" && node.children) {
      const inherit = parentMatched || selfMatches;
      for (const child of node.children) {
        if (walk(child, inherit)) subtreeHas = true;
      }
      if (subtreeHas || selfMatches || parentMatched) {
        visiblePaths.add(node.path);
        if (subtreeHas) forceOpenDirs.add(node.path);
        return true;
      }
      return false;
    }
    if (selfMatches || parentMatched) {
      visiblePaths.add(node.path);
      return true;
    }
    return false;
  };
  for (const n of tree) walk(n, false);
  return { visiblePaths, forceOpenDirs };
}
