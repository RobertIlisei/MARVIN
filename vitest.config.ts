import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "sidecar/packages/**/tests/**/*.test.ts",
      "sidecar/packages/**/*.test.ts",
      "sidecar/tests/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/dist/**",
      "graphify-out/**",
    ],
    // Unit tests are fast + pure; no need for jsdom here. The runtime /
    // tools / web API handlers we test are Node-environment code.
    environment: "node",
    // The disk-space floor for creating a worktree (ADR-0122) is a property of
    // the machine; no test should pass or fail on how full this one is. The
    // tests that exercise the floor set their own value.
    env: { MARVIN_WORKTREE_MIN_FREE_GB: "0" },
    // Keep the bar visible: terminal output should fit in ~40 lines of
    // test summary, not scroll pages.
    reporters: ["default"],
    // Disable test isolation per-file — our tests are pure functions +
    // tmp-dir fs calls, and isolation slows things down without a
    // correctness win.
    isolate: false,
  },
});
