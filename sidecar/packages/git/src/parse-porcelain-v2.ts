/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * Porcelain v2 is the stable machine-readable format:
 * <https://git-scm.com/docs/git-status#_porcelain_format_version_2>
 *
 * Why not v1: renames in v1 are surfaced as "D<old> \nA<new>" which
 * makes rename detection stateful and lossy. v2 exposes rename type in
 * a single record (lines starting with `2`).
 *
 * Why `-z`: NUL-delimited records. Paths with spaces / newlines /
 * unicode don't break the parser. The alternative (quoting, `\` escapes)
 * is tedious and error-prone on the consumer side.
 *
 * Input is the raw stdout string from `runGit`. Output is a structured
 * object; callers never touch raw porcelain text.
 *
 * See [ADR-0012](../../../docs/decisions/0012-source-control-mutation-channel.md).
 */

export type StatusCode =
  | "."
  | "M" // modified
  | "A" // added
  | "D" // deleted
  | "R" // renamed
  | "C" // copied
  | "U" // unmerged
  | "T" // type-changed
  | "?"; // untracked / ignored

export interface StatusFile {
  path: string;
  /** Status in the index (staged). */
  indexStatus: StatusCode;
  /** Status in the working tree (unstaged). */
  workingStatus: StatusCode;
  /** For rename entries, the source path; `null` otherwise. */
  renamedFrom: string | null;
  /**
   * `true` for ordinary changed entries (line type `1`).
   * `false` for rename/copy (type `2`), unmerged (type `u`), untracked
   * (type `?`), or ignored (type `!`).
   */
  ordinary: boolean;
  /** Entry type — surfaced so UIs can distinguish conflicts etc. */
  entryType: "ordinary" | "rename-copy" | "unmerged" | "untracked" | "ignored";
}

export interface StatusBranch {
  /** HEAD commit SHA. `null` when the repo has no commits yet. */
  oid: string | null;
  /** Current branch name. `null` when in detached HEAD. */
  name: string | null;
  /** Upstream tracking ref, e.g. `origin/main`. `null` when no upstream. */
  upstream: string | null;
  /** Commits ahead of upstream; `null` when no upstream. */
  ahead: number | null;
  /** Commits behind upstream; `null` when no upstream. */
  behind: number | null;
}

export interface StatusResult {
  branch: StatusBranch;
  files: StatusFile[];
}

/**
 * Parse the raw stdout of `git status --porcelain=v2 --branch -z`.
 *
 * The input is a NUL-delimited stream of records. Records starting
 * with `#` are header lines (branch metadata). Records starting with
 * `1`, `2`, `u`, `?`, or `!` are per-entry lines. Record type `2`
 * (rename/copy) consumes an EXTRA NUL-delimited field for the source
 * path.
 */
export function parsePorcelainV2(raw: string): StatusResult {
  const records = raw.split("\0");
  const branch: StatusBranch = {
    oid: null,
    name: null,
    upstream: null,
    ahead: null,
    behind: null,
  };
  const files: StatusFile[] = [];

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue; // trailing NUL produces an empty final record

    if (record.startsWith("# ")) {
      parseBranchHeader(record.slice(2), branch);
      continue;
    }

    const type = record[0];
    if (type === "1") {
      files.push(parseOrdinary(record));
      continue;
    }
    if (type === "2") {
      // Rename / copy. The next NUL-delimited field is the original path.
      const nextRecord = records[i + 1];
      const origPath = typeof nextRecord === "string" ? nextRecord : "";
      files.push(parseRenameCopy(record, origPath));
      i += 1; // consume the extra field
      continue;
    }
    if (type === "u") {
      files.push(parseUnmerged(record));
      continue;
    }
    if (type === "?") {
      files.push(parseUntracked(record));
      continue;
    }
    if (type === "!") {
      files.push(parseIgnored(record));
    }
    // Unknown record type — skip silently. Git may add new line types in
    // future versions; we shouldn't crash on forward-compat output.
  }

  return { branch, files };
}

function parseBranchHeader(body: string, branch: StatusBranch): void {
  // Header bodies: "branch.oid <sha>|(initial)", "branch.head <name>|(detached)",
  // "branch.upstream <ref>", "branch.ab +N -M".
  const spaceIdx = body.indexOf(" ");
  if (spaceIdx === -1) return;
  const key = body.slice(0, spaceIdx);
  const value = body.slice(spaceIdx + 1);
  switch (key) {
    case "branch.oid":
      branch.oid = value === "(initial)" ? null : value;
      return;
    case "branch.head":
      branch.name = value === "(detached)" ? null : value;
      return;
    case "branch.upstream":
      branch.upstream = value;
      return;
    case "branch.ab": {
      // Format: "+N -M"
      const match = /^\+(-?\d+)\s+-(-?\d+)$/.exec(value);
      if (!match) return;
      const aheadStr = match[1];
      const behindStr = match[2];
      if (!aheadStr || !behindStr) return;
      branch.ahead = Number.parseInt(aheadStr, 10);
      branch.behind = Number.parseInt(behindStr, 10);
      return;
    }
  }
}

/**
 * Ordinary changed entry (type `1`):
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 */
function parseOrdinary(record: string): StatusFile {
  const parts = splitFields(record, 8);
  const xy = parts[1] ?? "..";
  const path = parts[8] ?? "";
  return {
    path,
    indexStatus: asStatusCode(xy[0]),
    workingStatus: asStatusCode(xy[1]),
    renamedFrom: null,
    ordinary: true,
    entryType: "ordinary",
  };
}

/**
 * Rename / copy entry (type `2`):
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <XN> <path>
 * With `-z`, original path is the next NUL-delimited field.
 */
function parseRenameCopy(record: string, origPath: string): StatusFile {
  const parts = splitFields(record, 9);
  const xy = parts[1] ?? "..";
  const path = parts[9] ?? "";
  return {
    path,
    indexStatus: asStatusCode(xy[0]),
    workingStatus: asStatusCode(xy[1]),
    renamedFrom: origPath || null,
    ordinary: false,
    entryType: "rename-copy",
  };
}

/**
 * Unmerged entry (type `u`):
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 */
function parseUnmerged(record: string): StatusFile {
  const parts = splitFields(record, 10);
  const xy = parts[1] ?? "UU";
  const path = parts[10] ?? "";
  return {
    path,
    indexStatus: asStatusCode(xy[0]),
    workingStatus: asStatusCode(xy[1]),
    renamedFrom: null,
    ordinary: false,
    entryType: "unmerged",
  };
}

/** Untracked: `? <path>`. */
function parseUntracked(record: string): StatusFile {
  return {
    path: record.slice(2),
    indexStatus: ".",
    workingStatus: "?",
    renamedFrom: null,
    ordinary: false,
    entryType: "untracked",
  };
}

/** Ignored: `! <path>`. */
function parseIgnored(record: string): StatusFile {
  return {
    path: record.slice(2),
    indexStatus: ".",
    workingStatus: "?",
    renamedFrom: null,
    ordinary: false,
    entryType: "ignored",
  };
}

/**
 * Split a porcelain v2 record into its space-delimited header fields
 * plus a trailing path field. `expectedHeaderFields` is the count of
 * space-separated tokens before the path — the path itself may contain
 * spaces, so we slice rather than split-then-rejoin.
 */
function splitFields(record: string, expectedHeaderFields: number): string[] {
  const fields: string[] = [];
  let cursor = 0;
  for (let i = 0; i < expectedHeaderFields; i++) {
    const space = record.indexOf(" ", cursor);
    if (space === -1) {
      fields.push(record.slice(cursor));
      return fields;
    }
    fields.push(record.slice(cursor, space));
    cursor = space + 1;
  }
  // Remainder is the path.
  fields.push(record.slice(cursor));
  return fields;
}

function asStatusCode(c: string | undefined): StatusCode {
  switch (c) {
    case "M":
    case "A":
    case "D":
    case "R":
    case "C":
    case "U":
    case "T":
    case "?":
      return c;
    default:
      return ".";
  }
}
