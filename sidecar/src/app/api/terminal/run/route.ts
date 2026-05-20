import { spawn } from "node:child_process";
import path from "node:path";

import type { NextRequest } from "next/server";
import { validateProjectCwd } from "@marvin/runtime/projects";
import { requireMarvinClient } from "@/lib/csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunBody = { cwd?: string; cmd?: string };

const MAX_CMD_LEN = 8 * 1024;
const MAX_RUN_MS = 10 * 60 * 1000;

function shellFor(): [string, string[]] {
  const sh = process.env.SHELL ?? "/bin/sh";
  // `-c` + a single string is portable across zsh / bash / sh.
  return [sh, ["-c"]];
}

/**
 * Env vars MARVIN injects that should NEVER reach a user-typed shell
 * command. The Claude CLI subprocess gets these via `buildSubprocessEnv`
 * in `auth.ts` (the right behaviour — the CLI needs them), but arbitrary
 * shell commands the user runs in the embedded terminal should not.
 *
 * Audit 🟠 #8: a `npm install` from MARVIN's terminal would otherwise
 * see `ANTHROPIC_API_KEY` in `process.env` and could leak it via a
 * malicious postinstall script. `printenv` would echo every secret
 * back through the SSE stream and into the session JSONL (finding #7).
 *
 * User-set env that doesn't match any name on the list is preserved —
 * running `pnpm install` still finds the user's NPM_TOKEN, `gh`
 * still finds GH_TOKEN, etc. We only strip the vars MARVIN itself
 * injects + a small set of well-known auth/telemetry names.
 */
const SCRUB_EXACT = new Set<string>([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "HONEYCOMB_API_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
]);

function sanitizeSpawnEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // TS's @types/node declares ProcessEnv as a Record with NODE_ENV
  // required. The runtime shape is just a string dictionary, but to
  // satisfy the structural check we cast through a wider type.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (SCRUB_EXACT.has(k)) continue;
    out[k] = v;
  }
  return out as NodeJS.ProcessEnv;
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const guard = requireMarvinClient(req);
  if (guard) return guard;

  let body: RunBody;
  try {
    body = (await req.json()) as RunBody;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const cwd = body.cwd?.trim();
  const cmd = body.cmd?.trim();
  if (!cwd || !cmd) {
    return new Response("cwd and cmd required", { status: 400 });
  }
  if (cmd.length > MAX_CMD_LEN) {
    return new Response("cmd too long", { status: 413 });
  }
  // Audit 🟠 #9: only run in a registered project. Without this
  // check, anyone past CSRF could spawn shell commands in any
  // directory MARVIN's sidecar can read — including MARVIN's own
  // install dir.
  const projectCheck = validateProjectCwd(cwd);
  if (!projectCheck.ok) {
    return new Response(projectCheck.error, { status: projectCheck.status });
  }
  const resolvedCwd = projectCheck.workDir;

  const encoder = new TextEncoder();
  const [shBin, shArgs] = shellFor();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(event, data)));
        } catch {
          /* stream closed */
        }
      };

      const child = spawn(shBin, [...shArgs, cmd], {
        cwd: resolvedCwd,
        // Sanitised env (audit 🟠 #8). The shell still gets PATH,
        // HOME, the user's $SHELL, npm/git env they set themselves,
        // etc. — only MARVIN-injected secrets are stripped.
        env: sanitizeSpawnEnv(process.env),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const startedAt = Date.now();
      send("started", { pid: child.pid, cwd: resolvedCwd, cmd });

      const timeout = setTimeout(() => {
        send("stderr", { data: `\n[terminal] timeout after ${MAX_RUN_MS}ms\n` });
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }, MAX_RUN_MS);

      child.stdout.on("data", (d: Buffer) => {
        send("stdout", { data: d.toString("utf8") });
      });
      child.stderr.on("data", (d: Buffer) => {
        send("stderr", { data: d.toString("utf8") });
      });
      child.on("error", (err: Error) => {
        send("stderr", { data: `\n[terminal] ${err.message}\n` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        send("exit", {
          code: code ?? null,
          signal: signal ?? null,
          durationMs: Date.now() - startedAt,
        });
        close();
      });

      const abort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      };
      req.signal.addEventListener("abort", abort, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
