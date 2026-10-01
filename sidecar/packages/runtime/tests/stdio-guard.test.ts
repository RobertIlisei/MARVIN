import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { guardStdio } from "../src/stdio-guard";

const brokenPipe = () => Object.assign(new Error("write EPIPE"), { code: "EPIPE" });

/**
 * 2026-10-01: the app died, the sidecar's stdout pipe closed, and every log
 * line after that raised EPIPE as an uncaught exception — which Next logs to
 * the same dead pipe. The sidecar spun at 84 % CPU and answered nothing.
 */
describe("guardStdio", () => {
  it("an EPIPE on a guarded stream is absorbed, not thrown", () => {
    const out = new PassThrough();
    guardStdio([out]);
    expect(() => out.emit("error", brokenPipe())).not.toThrow();
  });

  it("an unguarded stream throws — the failure the guard exists for", () => {
    const out = new PassThrough();
    expect(() => out.emit("error", brokenPipe())).toThrow("EPIPE");
  });

  it("a process writing to a closed stdout keeps running and exits cleanly", async () => {
    const guard = join(__dirname, "../src/stdio-guard.ts");
    const script = `
      const { guardStdio } = await import(${JSON.stringify(guard)});
      guardStdio([process.stdout, process.stderr]);
      process.on("uncaughtException", (e) => { console.error("uncaught", e); process.exitCode = 3; });
      let n = 0;
      const t = setInterval(() => { console.log("line", n++); if (n > 40) { clearInterval(t); process.exit(process.exitCode ?? 0); } }, 5);
    `;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.destroy();
    child.stderr.destroy();
    const code = await new Promise<number | null>((done) => child.on("exit", (c) => done(c)));
    expect(code).toBe(0);
  }, 30_000);
});
