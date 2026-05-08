import { describe, expect, it } from "vitest";

import { computeFilterMatches } from "../src/components/file-tree/filter-matches";
import type { TreeNode } from "../src/components/file-tree/tree-node";

// A shared fixture mirroring the structure the tree API returns —
// enough depth to exercise parent-lifting + subtree-inherit logic.
//
// /
// ├── apps/
// │   └── web/
// │       ├── src/
// │       │   ├── components/
// │       │   │   ├── brain/
// │       │   │   │   ├── scout-orb.tsx
// │       │   │   │   └── advisor-orb.tsx
// │       │   │   └── file-tree/
// │       │   │       └── file-tree.tsx
// │       │   └── app/
// │       │       └── page.tsx
// │       └── package.json
// └── README.md
const FIXTURE: TreeNode[] = [
  {
    name: "apps",
    path: "/apps",
    type: "dir",
    children: [
      {
        name: "web",
        path: "/sidecar",
        type: "dir",
        children: [
          {
            name: "src",
            path: "/sidecar/src",
            type: "dir",
            children: [
              {
                name: "components",
                path: "/sidecar/src/components",
                type: "dir",
                children: [
                  {
                    name: "brain",
                    path: "/sidecar/src/components/brain",
                    type: "dir",
                    children: [
                      {
                        name: "scout-orb.tsx",
                        path: "/sidecar/src/components/brain/scout-orb.tsx",
                        type: "file",
                      },
                      {
                        name: "advisor-orb.tsx",
                        path: "/sidecar/src/components/brain/advisor-orb.tsx",
                        type: "file",
                      },
                    ],
                  },
                  {
                    name: "file-tree",
                    path: "/sidecar/src/components/file-tree",
                    type: "dir",
                    children: [
                      {
                        name: "file-tree.tsx",
                        path: "/sidecar/src/components/file-tree/file-tree.tsx",
                        type: "file",
                      },
                    ],
                  },
                ],
              },
              {
                name: "app",
                path: "/sidecar/src/app",
                type: "dir",
                children: [
                  { name: "page.tsx", path: "/sidecar/src/app/page.tsx", type: "file" },
                ],
              },
            ],
          },
          { name: "package.json", path: "/sidecar/package.json", type: "file" },
        ],
      },
    ],
  },
  { name: "README.md", path: "/README.md", type: "file" },
];

describe("computeFilterMatches", () => {
  it("matches a file by substring on its basename", () => {
    const { visiblePaths, forceOpenDirs } = computeFilterMatches(FIXTURE, "scout");
    // The file itself is visible, plus the ancestor chain so the
    // result isn't an orphaned leaf.
    expect(visiblePaths).toContain("/sidecar/src/components/brain/scout-orb.tsx");
    expect(visiblePaths).toContain("/sidecar/src/components/brain");
    expect(visiblePaths).toContain("/sidecar/src/components");
    expect(visiblePaths).toContain("/sidecar/src");
    expect(visiblePaths).toContain("/sidecar");
    expect(visiblePaths).toContain("/apps");
    // Sibling files should be hidden.
    expect(visiblePaths).not.toContain("/sidecar/src/components/brain/advisor-orb.tsx");
    expect(visiblePaths).not.toContain("/README.md");
    // Every ancestor of the match becomes force-open so users see the
    // result without manual expansion.
    expect(forceOpenDirs).toContain("/sidecar/src/components/brain");
    expect(forceOpenDirs).toContain("/apps");
  });

  it("is case-insensitive", () => {
    const lower = computeFilterMatches(FIXTURE, "readme");
    const upper = computeFilterMatches(FIXTURE, "README");
    const mixed = computeFilterMatches(FIXTURE, "ReadMe");
    expect(lower.visiblePaths).toContain("/README.md");
    expect(upper.visiblePaths).toContain("/README.md");
    expect(mixed.visiblePaths).toContain("/README.md");
  });

  it("lifts an entire subtree when the dir name itself matches", () => {
    // VS Code behaviour: typing "brain" should show everything under
    // brain/ without requiring each descendant to match too.
    const { visiblePaths } = computeFilterMatches(FIXTURE, "brain");
    expect(visiblePaths).toContain("/sidecar/src/components/brain/scout-orb.tsx");
    expect(visiblePaths).toContain("/sidecar/src/components/brain/advisor-orb.tsx");
    // But NOT leak to sibling dirs at the same level.
    expect(visiblePaths).not.toContain("/sidecar/src/components/file-tree/file-tree.tsx");
  });

  it("matches multiple results across unrelated branches", () => {
    const { visiblePaths } = computeFilterMatches(FIXTURE, ".tsx");
    // All three .tsx files + their ancestor chains, no .md, no
    // package.json.
    expect(visiblePaths).toContain("/sidecar/src/components/brain/scout-orb.tsx");
    expect(visiblePaths).toContain("/sidecar/src/components/brain/advisor-orb.tsx");
    expect(visiblePaths).toContain("/sidecar/src/components/file-tree/file-tree.tsx");
    expect(visiblePaths).toContain("/sidecar/src/app/page.tsx");
    expect(visiblePaths).not.toContain("/sidecar/package.json");
    expect(visiblePaths).not.toContain("/README.md");
  });

  it("returns empty sets when nothing matches", () => {
    const { visiblePaths, forceOpenDirs } = computeFilterMatches(FIXTURE, "no-such-thing");
    expect(visiblePaths.size).toBe(0);
    expect(forceOpenDirs.size).toBe(0);
  });

  it("force-opens ancestor dirs so results are visible without manual expansion", () => {
    // The ancestor chain up to the match should all be in forceOpenDirs
    // — otherwise the user sees the collapsed tree and wonders where
    // the filter went.
    const { forceOpenDirs } = computeFilterMatches(FIXTURE, "page.tsx");
    expect(forceOpenDirs).toContain("/sidecar/src/app");
    expect(forceOpenDirs).toContain("/sidecar/src");
    expect(forceOpenDirs).toContain("/sidecar");
    expect(forceOpenDirs).toContain("/apps");
    // A dir with no matches under it must NOT be force-opened.
    expect(forceOpenDirs).not.toContain("/sidecar/src/components");
  });
});
