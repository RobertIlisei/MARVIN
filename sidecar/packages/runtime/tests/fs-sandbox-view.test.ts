import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkFsPath,
  checkViewPath,
  describeSandboxError,
  viewableTempRoots,
} from "../src/fs-sandbox";
import { addProject } from "../src/projects";

// 2026-11-26 — a tab links a capture it copied into /tmp; the file viewer
// opens it for DISPLAY and the sandbox answered 400 path-escapes-cwd, which
// the app printed as "FilesServiceError error 0". checkViewPath is the
// read-only counterpart of checkFsPath: the same sandbox, plus regular files
// under the system temp roots, never a symlink, never a write. The temp roots
// are injected so these tests do not depend on where the machine's tmp lives.

let tmp: string; // the registered project
let scratch: string; // stands in for /tmp
let elsewhere: string; // a real directory outside the project AND the temp roots
let dataDir: string;

async function mk(prefix: string): Promise<string> {
  return await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), prefix)));
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(tmpdir(), "marvin-view-data-"));
  process.env.MARVIN_DATA_DIR = dataDir;
  tmp = await mk("marvin-view-proj-");
  scratch = await mk("marvin-view-scratch-");
  elsewhere = await mk("marvin-view-else-");
  await fs.writeFile(path.join(tmp, "hello.txt"), "hi");
  await fs.mkdir(path.join(scratch, "shots"));
  await fs.writeFile(path.join(scratch, "shots", "a.png"), "png-bytes");
  await fs.writeFile(path.join(elsewhere, "secret.txt"), "secret");
  addProject({ workDir: tmp });
});

afterEach(async () => {
  delete process.env.MARVIN_DATA_DIR;
  for (const d of [tmp, scratch, elsewhere, dataDir]) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

const view = (target: string, tempRoots?: string[]) =>
  checkViewPath({ cwd: tmp, target, tempRoots: tempRoots ?? [scratch] });

describe("checkViewPath — files a session linked from a temp dir", () => {
  it("still answers a project file as before, not flagged outside", async () => {
    const r = await view(path.join(tmp, "hello.txt"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.outsideProject).toBeFalsy();
  });

  it("opens a regular file under a temp root and marks it outside the project", async () => {
    const r = await view(path.join(scratch, "shots", "a.png"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outsideProject).toBe(true);
      expect(r.absolutePath).toBe(path.join(scratch, "shots", "a.png"));
    }
  });

  it("opens it through a symlinked temp root (/tmp -> /private/tmp shape)", async () => {
    const alias = path.join(elsewhere, "tmp-alias");
    await fs.symlink(scratch, alias);
    const r = await view(path.join(alias, "shots", "a.png"), [alias]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absolutePath).toBe(path.join(scratch, "shots", "a.png"));
  });

  it("refuses a file outside the project and every temp root", async () => {
    const r = await view(path.join(elsewhere, "secret.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path-escapes-cwd");
  });

  it("refuses a '..' walk out of a temp root", async () => {
    const r = await view(path.join(scratch, "..", path.basename(elsewhere), "secret.txt"));
    expect(r.ok).toBe(false);
  });

  it("refuses a relative target that climbs out of the project into a temp root", async () => {
    const r = await view(path.relative(tmp, path.join(scratch, "shots", "a.png")));
    expect(r.ok).toBe(false);
  });

  it("refuses a look-alike sibling that only shares the root's prefix", async () => {
    const lookalike = `${scratch}-evil`;
    await fs.mkdir(lookalike);
    await fs.writeFile(path.join(lookalike, "x.png"), "x");
    try {
      const r = await view(path.join(lookalike, "x.png"));
      expect(r.ok).toBe(false);
    } finally {
      await fs.rm(lookalike, { recursive: true, force: true });
    }
  });

  it("refuses a symlink at the target, even one that points inside the root", async () => {
    const link = path.join(scratch, "link.png");
    await fs.symlink(path.join(scratch, "shots", "a.png"), link);
    const r = await view(link);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("symlink-rejected");
  });

  it("refuses a file reached through a directory symlink that leaves the root", async () => {
    await fs.symlink(elsewhere, path.join(scratch, "out"));
    const r = await view(path.join(scratch, "out", "secret.txt"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("symlink-escapes-cwd");
  });

  it("refuses a directory (no listing)", async () => {
    const r = await view(path.join(scratch, "shots"));
    expect(r.ok).toBe(false);
  });

  it("refuses a FIFO — opening one for read would hang the route", async () => {
    const fifo = path.join(scratch, "pipe");
    execFileSync("mkfifo", [fifo]);
    const r = await view(fifo);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not-regular-file");
  });

  it("answers a missing and a present path outside the roots identically", async () => {
    const present = await view(path.join(elsewhere, "secret.txt"));
    const absent = await view(path.join(elsewhere, "nope.txt"));
    expect(present.ok).toBe(false);
    expect(absent.ok).toBe(false);
    if (!present.ok && !absent.ok) expect(present.error).toBe(absent.error);
  });

  it("a missing file under a temp root is not-found", async () => {
    const r = await view(path.join(scratch, "nope.png"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("not-found");
  });

  it("refuses a NUL byte", async () => {
    const r = await view(`${path.join(scratch, "shots", "a.png")}\0.txt`);
    expect(r.ok).toBe(false);
  });

  it("checkFsPath itself stays strict: the write channel never sees temp files", async () => {
    const r = await checkFsPath({
      cwd: tmp,
      target: path.join(scratch, "shots", "a.png"),
    });
    expect(r.ok).toBe(false);
  });

  it("an unregistered cwd gets nothing, temp file or not", async () => {
    const r = await checkViewPath({
      cwd: elsewhere,
      target: path.join(scratch, "shots", "a.png"),
      tempRoots: [scratch],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("cwd-not-registered");
  });
});

describe("viewableTempRoots", () => {
  it("includes the machine's temp dir, canonicalised", async () => {
    const roots = await viewableTempRoots();
    expect(roots).toContain(await fs.realpath(tmpdir()));
  });

  it("never offers the filesystem root or the home directory", async () => {
    const prev = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/";
      expect(await viewableTempRoots()).not.toContain("/");
      process.env.TMPDIR = homedir();
      expect(await viewableTempRoots()).not.toContain(await fs.realpath(homedir()));
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
    }
  });
});

describe("describeSandboxError — readable, not an error code", () => {
  it("says what was refused and why, with the path", () => {
    const m = describeSandboxError("path-escapes-cwd", "/Users/x/.ssh/id_rsa");
    expect(m).toContain("outside the project");
    expect(m).toContain("/Users/x/.ssh/id_rsa");
    expect(m).not.toContain("path-escapes-cwd");
  });

  it("has a sentence for every code", () => {
    for (const code of [
      "cwd-not-absolute",
      "cwd-not-registered",
      "path-contains-null",
      "path-too-long",
      "path-escapes-cwd",
      "symlink-rejected",
      "symlink-escapes-cwd",
      "not-found",
      "parent-not-found",
      "is-directory",
      "not-a-directory",
      "not-regular-file",
      "io-error",
    ] as const) {
      const m = describeSandboxError(code, "/p");
      expect(m.length).toBeGreaterThan(15);
      expect(m).not.toBe(code);
    }
  });
});
