import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
  // module identity at runtime — `@anthropic-ai/*` need full Node APIs,
  // not bundler shims.
  serverExternalPackages: [
    "@anthropic-ai/sdk",
    "@anthropic-ai/claude-agent-sdk",
  ],
};

export default nextConfig;
