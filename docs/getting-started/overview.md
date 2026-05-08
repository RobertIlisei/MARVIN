# Overview

**MARVIN** is a pair-programming AI assistant. One human drives vision and business decisions; one AI — MARVIN — owns architecture, infrastructure, code, tests, docs, security.

You say "let's build the login page." MARVIN reads the codebase, proposes the schema + wiring + tests, executes with explicit confirms, commits.

> "Here I am, brain the size of a planet, and they ask me to build a login page."

## What MARVIN is

- A **single-assistant** desktop application built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview). One Claude session in a user ↔ MARVIN loop. See [ADR-0001](../decisions/0001-single-assistant.md) for why.
- A **native macOS app** (`macos/`, SwiftUI / AppKit / MetalKit) + a **Next.js 16 sidecar** (`sidecar/`) on `localhost:3030`. The Swift app is the entire UI — chat, file tree, source control, terminal, diff viewer, brain visualisation. The sidecar is the backend it talks to over HTTP/SSE. See [Architecture](./architecture.md).
- A **per-project** workspace. Each project has its own knowledge graph (`<workDir>/graphify-out/`), its own ADRs (`<workDir>/docs/adr/*.md`), and its own memory log (`<workDir>/.marvin/memory.md`). MARVIN holds zero cross-session state about past projects.
- An **operating model**, not just a chat frontend. MARVIN runs an 8-phase dialog on every change request: intake → discovery → impact analysis → architecture → plan → implement → verify → ship. See [The 8-phase workflow](../concepts/eight-phase-workflow.md).
- A **tool-permission layer**. Every tool call is classified as auto-allowed, confirm-before-act, or hard-denied. Structural gate lives in `sidecar/packages/runtime/src/sdk-runner.ts`'s `canUseTool` callback. See [Tool policy](../security/tool-policy.md).

## What MARVIN is explicitly not

- **Not a multi-agent orchestration.** No CEO-agent dispatching PO-agent dispatching engineer-agents. Research on 2026 sequential-coding tasks shows multi-agent autonomy degrades quality up to ~70% and amplifies error rates 17× in flat-topology "bag of agents" setups. See [Single-assistant philosophy](../concepts/single-assistant.md).
- **Not a replacement for Claude Code.** Claude Code is the CLI harness; MARVIN is a desktop app built around the Agent SDK. If you want a terminal-native tool, use Claude Code.
- **Not cross-platform.** SwiftUI + AppKit means macOS only. There is no Windows or Linux build.
- **Not a hosted product.** MARVIN runs locally, talks to Anthropic's API using your credentials, and stores everything on your machine. There is no MARVIN server.
- **Not multi-tenant.** One user, one machine. Sessions and cost tracking are per-project, not per-user.

## Who it's for

- **Solo developers** and **small teams** who want AI pair-programming with explicit confirms instead of autonomous agents.
- **Engineers who already use Claude Code** and want a desktop IDE-grade view into the same Agent SDK runtime, with a knowledge graph alongside.
- **Anyone skeptical of multi-agent AI.** The single-assistant rationale ([ADR-0001](../decisions/0001-single-assistant.md)) is backed by 2026 research from Google, UIUC, Microsoft, and Anthropic Research.

## What you need

- macOS 14 (Sonoma) or later.
- Xcode 16+ or just the Command Line Tools (`xcode-select --install`) — the installer falls back to the SPM build path if Xcode is missing.
- Node.js **>= 22** and pnpm — the installer auto-installs both via Homebrew on a fresh macbook.
- Claude credentials — an `ANTHROPIC_API_KEY`, or a `claude auth login` done previously (auto-detected).
- Optional: `npx playwright install chromium` if you want MARVIN to drive a browser against your local dev server.

See [Quickstart](./quickstart.md) for the one-liner install.

## The short pitch

If you've ever wanted Claude Code, but:

- as a **native macOS app** with a real Dock icon, menu bar, and window state;
- with a **visible brain** that makes it clear when MARVIN is thinking vs running a tool vs writing;
- with a **knowledge graph** loaded into context on the first turn so structural questions don't cost 10 file reads;
- with a **diff you can see** before allowing it;
- with a **cost meter** per project so you know what each conversation costs;
- and with a **refusal to split itself into multiple agents** that pretend to hand off tasks to each other —

that is MARVIN.
