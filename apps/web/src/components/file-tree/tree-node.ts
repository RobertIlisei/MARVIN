/**
 * Shared TreeNode type. Extracted to a pure `.ts` file so non-TSX
 * consumers (Vitest, pure helpers like `filter-matches.ts`) can
 * import it without dragging in React or JSX parsing.
 *
 * `file-tree.tsx` re-exports this type so existing imports of
 * `TreeNode` from `file-tree` keep working.
 */
export type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};
