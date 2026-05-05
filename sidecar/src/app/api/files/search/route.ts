// GET /api/files/search?cwd=<dir>&q=<query>&caseSensitive=0&wholeWord=0&useRegex=0&include=<glob>
//
// Runs ripgrep against the project directory and returns structured
// matches. ripgrep handles .gitignore / .ignore natively, so the
// result excludes node_modules, dist, etc. automatically.
//
// Optional `include` param: comma-separated glob patterns forwarded
// to rg as --glob flags (e.g. "*.ts,*.tsx" or "src/**").
//
// Response shape:
//   { results: [{ file, matches: [{ line, col, text }] }], truncated }
//
// Caps: 500 matching files, 50 matches per file, 10 s timeout.
// ripgrep exits 0 on match, 1 on no match, 2 on error.

import { spawn } from "node:child_process";
import path from "node:path";

import { checkFsPath } from "@marvin/runtime/fs-sandbox";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILES = 500;
const MAX_MATCHES_PER_FILE = 50;
const TIMEOUT_MS = 10_000;

export type SearchMatch = { line: number; col: number; text: string };
export type SearchFileResult = { file: string; matches: SearchMatch[] };
export type SearchResponse = { results: SearchFileResult[]; truncated: boolean };

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd");
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const caseSensitive = req.nextUrl.searchParams.get("caseSensitive") === "1";
  const wholeWord = req.nextUrl.searchParams.get("wholeWord") === "1";
  const useRegex = req.nextUrl.searchParams.get("useRegex") === "1";
  // Comma-separated glob patterns — each becomes a separate --glob flag.
  const includeRaw = req.nextUrl.searchParams.get("include") ?? "";
  const includeGlobs = includeRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });
  if (!q.trim()) return NextResponse.json({ results: [], truncated: false });

  const check = await checkFsPath({ cwd, target: cwd, mustExist: true, allowDirectory: true });
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

  const root = check.absolutePath;

  // Build rg args. --json gives structured NDJSON output.
  const args: string[] = [
    "--json",
    "--max-count", String(MAX_MATCHES_PER_FILE),
    "--max-filesize", "2M",
    "--max-depth", "20",
  ];
  if (!caseSensitive) args.push("--ignore-case");
  if (wholeWord) args.push("--word-regexp");
  if (!useRegex) args.push("--fixed-strings");
  for (const glob of includeGlobs) {
    args.push("--glob", glob);
  }
  args.push("--", q, root);

  const rgPath = process.env.RG_PATH ?? "rg";

  const output = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const proc = spawn(rgPath, args, { cwd: root });
    const timer = setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, TIMEOUT_MS);
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    proc.on("error", reject);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "timeout") return "__TIMEOUT__";
    throw err;
  });

  if (output === "__TIMEOUT__") {
    return NextResponse.json({ error: "search timed out" }, { status: 504 });
  }

  // Parse rg JSON output (one JSON object per line).
  const fileMap = new Map<string, SearchMatch[]>();
  let truncated = false;

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (msg.type === "match") {
      const data = msg.data as Record<string, unknown>;
      const filePath = (data.path as { text: string }).text;
      const lineNo = (data.line_number as number) ?? 0;
      const submatches = (data.submatches as Array<{ start: number }>);
      const col = submatches?.[0]?.start ?? 0;
      const textRaw = data.lines as { text?: string; bytes?: string };
      const text = (textRaw.text ?? "").replace(/\n$/, "");

      if (!fileMap.has(filePath)) {
        if (fileMap.size >= MAX_FILES) { truncated = true; continue; }
        fileMap.set(filePath, []);
      }
      fileMap.get(filePath)!.push({ line: lineNo, col: col + 1, text });
    }
  }

  const results: SearchFileResult[] = [];
  for (const [file, matches] of fileMap) {
    const rel = path.relative(root, file);
    results.push({ file: rel, matches });
  }

  return NextResponse.json({ results, truncated } satisfies SearchResponse);
}
