/**
 * Playwright MCP factory for MARVIN.
 *
 * Registers Microsoft's official `@playwright/mcp` as a stdio MCP server
 * under the name `marvin-playwright` in every SDK turn. Gives MARVIN a
 * browser it actually controls — no sandbox between it and
 * `localhost:*`, no LAN block. MARVIN can navigate, screenshot, click,
 * fill forms, read the DOM, and tail the browser console against any
 * HTTP URL reachable from the MARVIN host.
 *
 * **Not MARVIN-specific.** Playwright is project-agnostic by nature:
 * it's a browser, it follows a URL, it reports what it sees. Same
 * tool for a clinic site, a dashboard, a game — the URL is the only
 * input.
 *
 * **Opt-out.** Set `MARVIN_PLAYWRIGHT=0` in the environment to disable
 * registration (useful if the host has no Chromium installed and you
 * want to skip the spawn cost). Default: enabled.
 *
 * **Browser data dir.** By default MARVIN asks Playwright to use an
 * isolated, ephemeral profile so sessions don't leak state across
 * projects. Override with `MARVIN_PLAYWRIGHT_PROFILE=/path/to/dir`
 * if you want persistence.
 */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

function trimEnv(name: string): string {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Find the workspace root by walking up from `start` looking for a
 * `pnpm-workspace.yaml` / `package.json` with `workspaces` / a `.git`
 * directory — whichever comes first. Falls back to `start` itself.
 */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (
      existsSync(join(dir, "pnpm-workspace.yaml")) ||
      existsSync(join(dir, ".git"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * Resolve the absolute path of `@playwright/mcp`'s CLI entry point.
 * The package's `exports` map does not expose `cli.js` directly, so we
 * resolve its `package.json` (which IS exported) and derive the CLI
 * path from there. This keeps us agnostic to the package manager's
 * node_modules layout (pnpm's `.pnpm/…` vs flat npm/yarn).
 *
 * Multiple resolution bases are tried in order because a bundler
 * (Next.js, webpack, etc.) may transform `import.meta.url` into a
 * synthetic URL where `require.resolve` can't find `@playwright/mcp`.
 * For pnpm-style monorepos the package often lives inside
 * `packages/runtime/node_modules/` (private to the depending package),
 * so we also try a few well-known workspace paths before giving up.
 *
 * Returns `null` when the package isn't installed.
 */
function resolveCliPath(): string | null {
  const workspaceRoot = findWorkspaceRoot(process.cwd());

  const bases: string[] = [
    import.meta.url,
    join(workspaceRoot, "packages", "runtime", "__resolve"),
    join(workspaceRoot, "apps", "web", "__resolve"),
    join(workspaceRoot, "__resolve"),
    join(process.cwd(), "__resolve"),
  ];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const pkgJsonPath = req.resolve("@playwright/mcp/package.json");
      const cliPath = join(dirname(pkgJsonPath), "cli.js");
      if (existsSync(cliPath)) return cliPath;
    } catch {
      /* try next base */
    }
  }

  // Filesystem fallbacks, in order: the runtime package's own
  // node_modules (pnpm symlink), pnpm's content-addressed store, and
  // plain node_modules folders walking up from cwd.
  const directGuesses = [
    join(workspaceRoot, "packages", "runtime", "node_modules", "@playwright", "mcp", "cli.js"),
    join(workspaceRoot, "node_modules", "@playwright", "mcp", "cli.js"),
  ];
  for (const guess of directGuesses) {
    if (existsSync(guess)) return guess;
  }

  // pnpm's .pnpm store: any matching @playwright+mcp@* directory wins.
  try {
    const pnpmDir = join(workspaceRoot, "node_modules", ".pnpm");
    if (existsSync(pnpmDir)) {
      for (const entry of (readdirSync(pnpmDir) || [])) {
        if (!entry.startsWith("@playwright+mcp@")) continue;
        const guess = join(pnpmDir, entry, "node_modules", "@playwright", "mcp", "cli.js");
        if (existsSync(guess)) return guess;
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * Build an `McpStdioServerConfig` that spawns `@playwright/mcp` via Node
 * with sensible defaults, or return `null` when Playwright MCP should
 * not register for this turn.
 */
export function createPlaywrightMcpConfig(): McpStdioServerConfig | null {
  if (trimEnv("MARVIN_PLAYWRIGHT") === "0") return null;

  const cli = resolveCliPath();
  if (!cli) return null;

  const args: string[] = [cli];

  // Headless by default — visible windows popping up on every SDK turn
  // would be hostile to a server process. User can opt into headed via
  // MARVIN_PLAYWRIGHT_HEADED=1.
  if (trimEnv("MARVIN_PLAYWRIGHT_HEADED") !== "1") {
    args.push("--headless");
  }

  // Browser selection — default Chromium. Falls through to whatever
  // Playwright's defaults are if this isn't set.
  const browser = trimEnv("MARVIN_PLAYWRIGHT_BROWSER");
  if (browser) args.push("--browser", browser);

  // Persistent profile dir — default is isolated per-session.
  const profile = trimEnv("MARVIN_PLAYWRIGHT_PROFILE");
  if (profile) args.push("--user-data-dir", profile);
  else args.push("--isolated");

  // Viewport — useful for screenshot consistency across sessions.
  const viewport = trimEnv("MARVIN_PLAYWRIGHT_VIEWPORT");
  if (viewport) args.push("--viewport-size", viewport);

  return {
    type: "stdio",
    command: "node",
    args,
    // Inherit the host env so localhost connections, proxies, CA certs
    // etc. keep working. No credentials are forwarded explicitly —
    // Playwright doesn't need them.
    env: process.env as Record<string, string>,
  };
}
