import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  GRAPHIFY_MISSING_HINT,
  graphifyCandidates,
  graphifyMissingHint,
  graphifyPython,
  graphifyVersion,
  resolveGraphifyBin,
} from "../src/graphify-bin";

/**
 * 2026-09-23: MARVIN spawned a bare `graphify` from a launchd PATH with no
 * `~/.local/bin`, so it ran a stale Homebrew-pip 0.9.53 while the user's
 * shell (uv tool) ran 0.9.65. The property under test: the resolver finds
 * the uv / pipx install without PATH's help, and between two installs picks
 * the newer one.
 *
 * Fake versions are 9.9.x so they beat any real graphify on the host
 * (the resolver also searches /opt/homebrew/bin and /usr/local/bin).
 */

const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

function fakeGraphify(dir: string, output: string, exitCode = 0): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "graphify");
  writeFileSync(p, `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`);
  chmodSync(p, 0o755);
  return p;
}

const tempHome = () => mkdtempSync(join(tmpdir(), "gbin-home-"));

describe("resolveGraphifyBin", () => {
  it("finds a uv / pipx install in ~/.local/bin when PATH does not include it", () => {
    const home = tempHome();
    const uv = fakeGraphify(join(home, ".local", "bin"), "graphify 9.9.65");
    expect(resolveGraphifyBin({ home, env: { NODE_ENV: "test", PATH: LAUNCHD_PATH } })).toBe(uv);
  });

  it("picks the newest install, not the first one found (0.9.65 beats 0.9.53)", () => {
    const home = tempHome();
    fakeGraphify(join(home, ".local", "bin"), "graphify 9.9.53");
    const onPath = fakeGraphify(join(home, "elsewhere"), "graphify 9.9.65");
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: `${join(home, "elsewhere")}:${LAUNCHD_PATH}` };
    expect(resolveGraphifyBin({ home, env })).toBe(onPath);
  });

  it("finds a `pip install --user` copy under ~/Library/Python/<ver>/bin", () => {
    const home = tempHome();
    const pipUser = fakeGraphify(join(home, "Library", "Python", "3.14", "bin"), "graphify 9.9.70");
    expect(graphifyCandidates({ home, env: { NODE_ENV: "test", PATH: "" } })).toContain(pipUser);
    expect(resolveGraphifyBin({ home, env: { NODE_ENV: "test", PATH: LAUNCHD_PATH } })).toBe(pipUser);
  });

  it("lets GRAPHIFY_BIN win outright", () => {
    const home = tempHome();
    fakeGraphify(join(home, ".local", "bin"), "graphify 9.9.99");
    const pinned = join(home, "pinned", "graphify");
    expect(resolveGraphifyBin({ home, env: { NODE_ENV: "test", PATH: LAUNCHD_PATH, GRAPHIFY_BIN: pinned } })).toBe(pinned);
  });

  it.skipIf(existsSync("/opt/homebrew/bin/graphify") || existsSync("/usr/local/bin/graphify"))(
    "falls back to bare `graphify` when nothing is installed",
    () => {
      expect(resolveGraphifyBin({ home: tempHome(), env: { NODE_ENV: "test", PATH: LAUNCHD_PATH } })).toBe("graphify");
    },
  );
});

describe("graphifyVersion", () => {
  it("parses `graphify 0.9.65` and returns null for a broken binary", () => {
    const d = mkdtempSync(join(tmpdir(), "gbin-"));
    expect(graphifyVersion(fakeGraphify(join(d, "a"), "graphify 0.9.65"))).toEqual([0, 9, 65]);
    expect(graphifyVersion(fakeGraphify(join(d, "b"), "boom", 1))).toBeNull();
    expect(graphifyVersion(join(d, "missing"))).toBeNull();
  });
});

describe("graphifyMissingHint", () => {
  it("turns a real ENOENT spawn failure into the install hint, and nothing else", async () => {
    const err = await promisify(execFile)(join(tmpdir(), "no-such-graphify-binary"), ["--version"]).catch(
      (e: unknown) => e,
    );
    expect(graphifyMissingHint(err)).toBe(GRAPHIFY_MISSING_HINT);
    expect(graphifyMissingHint(new Error("exit 1"))).toBeNull();
  });
});

/**
 * 2026-09-29: the knowledge-graph builder imports graphify as a library and
 * was spawned with the system `python3`, which cannot see a uv / pipx venv —
 * it exited 2 on every turn. The interpreter must come from the CLI's shebang.
 */
describe("graphifyPython", () => {
  it("returns the interpreter named in the graphify CLI's shebang", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpy-"));
    const python = join(dir, "python");
    writeFileSync(python, "#!/bin/sh\n");
    chmodSync(python, 0o755);
    const bin = join(dir, "graphify");
    writeFileSync(bin, `#!${python}\nfrom graphify.__main__ import main\n`);
    chmodSync(bin, 0o755);
    expect(graphifyPython({ env: { GRAPHIFY_BIN: bin, NODE_ENV: "test" } })).toBe(python);
  });

  it("falls back to python3 for an env shebang, a missing CLI or a missing interpreter", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpy-"));
    const envShebang = join(dir, "graphify-env");
    writeFileSync(envShebang, "#!/usr/bin/env python3\n");
    const gone = join(dir, "graphify-gone");
    writeFileSync(gone, `#!${join(dir, "no-such-python")}\n`);
    expect(graphifyPython({ env: { GRAPHIFY_BIN: envShebang, NODE_ENV: "test" } })).toBe("python3");
    expect(graphifyPython({ env: { GRAPHIFY_BIN: gone, NODE_ENV: "test" } })).toBe("python3");
    expect(graphifyPython({ env: { GRAPHIFY_BIN: join(dir, "absent"), NODE_ENV: "test" } })).toBe("python3");
  });
});
