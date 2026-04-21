import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output — produces `.next/standalone/` with a minimal
  // runtime + server.js, suitable for bundling inside MARVIN's Tauri
  // `.app` (see ADR-0011). In dev + browser-tab mode this has no
  // observable effect.
  output: "standalone",
  // Tell Next's file tracer that the monorepo root lives two dirs up,
  // not here — otherwise workspace packages (`@marvin/*`) don't get
  // pulled into the standalone output and the server crashes on import.
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  // Pass through workspace package transpilation — our /packages/* source uses
  // .ts directly and Next 16 handles it out of the box, but making the list
  // explicit documents intent.
  transpilePackages: [
    "@marvin/runtime",
    "@marvin/tools",
    "@marvin/project-context",
    "@marvin/graphify-bridge",
    "@marvin/git-watch",
    "@marvin/ui",
  ],
  // Next.js 16: formerly `experimental.serverComponentsExternalPackages`.
  // Keeps these packages out of the server bundle so they keep real
  // module identity at runtime — important for `@playwright/mcp`
  // (we resolve its CLI path via `require.resolve`) and
  // `@anthropic-ai/*` (need full Node APIs, not bundler shims).
  serverExternalPackages: [
    "@anthropic-ai/sdk",
    "@anthropic-ai/claude-agent-sdk",
    "@playwright/mcp",
  ],
};

export default nextConfig;
