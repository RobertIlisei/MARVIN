import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone server output for the bundled .app sidecar. Per ADR-0023,
  // the brew-distributed MARVIN.app ships .next/standalone/ + bundled node
  // inside Contents/Resources. The standalone tree pulls in only the
  // node_modules the server actually touches at runtime.
  //
  // outputFileTracingRoot is critical here: Next defaults to scanning the
  // package directory only, but our @marvin/* workspace packages live
  // one level up at ../packages/. Pointing the trace root at the repo
  // root makes the tracer follow the workspace symlinks and bundle the
  // real source — without this the standalone server crashes on first
  // request with "Cannot find module '@marvin/runtime'".
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, ".."),
  // We don't use `next/image` (chat is text-driven, files are markdown
  // or code). Disable Next's image optimizer so the standalone bundle
  // doesn't drag in sharp's cross-arch libvips binaries (~150 MB of
  // .so files for Linux, riscv64, ppc64, etc., none of which we ship).
  // ADR-0023 §Sizing.
  images: { unoptimized: true },
  // Force-include the platform-specific Claude Agent SDK native binary.
  // The SDK loads `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
  // via dynamic require at runtime — Next's static trace can't see it,
  // so it gets dropped from the standalone bundle. Without this, the
  // bundled sidecar inside MARVIN.app throws on every chat turn:
  //   "Native CLI binary for darwin-arm64 not found."
  // We only ship darwin-arm64 builds (see .github/workflows/release.yml),
  // so we only need the one platform variant.
  outputFileTracingIncludes: {
    "**/*": [
      "../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64*/**",
    ],
  },
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
