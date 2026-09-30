/**
 * ADR-0124 — the Bash source-read classifier. Every command below is a shape
 * taken from the agri-saas-platform tab transcripts of 2026-09-30 (paths kept,
 * long tails trimmed), so the gate is pinned against what tabs actually run.
 */
import { describe, expect, it } from "vitest";
import { classifyBashSourceAccess, NARROW_READ_MAX_LINES } from "../src/bash-search";

const ROOT = "/p/agri";
const TAB = `${ROOT}/.marvin/worktrees/tab-plan-b-farmer-app`;

function kinds(cmd: string, cwd = ROOT) {
  return classifyBashSourceAccess(cmd, cwd, ROOT).map((a) => ({
    kind: a.kind,
    tool: a.tool,
    narrow: a.narrow,
    files: a.files.map((f) => f.replace(`${ROOT}/`, "")),
    dirs: a.dirs.map((d) => (d === ROOT ? "." : d.replace(`${ROOT}/`, ""))),
  }));
}

describe("classifyBashSourceAccess — real transcript shapes", () => {
  it("sed -n range on one file is a narrow read", () => {
    expect(kinds("sed -n 36,46p src/routes/platform/settings.tsx")).toEqual([
      { kind: "read", tool: "sed", narrow: true, files: ["src/routes/platform/settings.tsx"], dirs: [] },
    ]);
  });

  it("two sed ranges in one command are two narrow reads", () => {
    const r = kinds("sed -n 1,40p account.tsx; sed -n 130,270p account.tsx");
    expect(r).toHaveLength(2);
    expect(r.every((a) => a.narrow)).toBe(true);
  });

  it("a sed range wider than the cap is a wide read", () => {
    const r = classifyBashSourceAccess("sed -n 1,400p src/x.tsx", ROOT, ROOT);
    expect(r[0]?.narrow).toBe(false);
    expect(400).toBeGreaterThan(NARROW_READ_MAX_LINES);
  });

  it("cd into a subdir, then cat several files, is a whole-file read resolved from the cd", () => {
    const r = kinds("cd apps/web/src && cat routes/registry/farmer.ts routes/registry/types.ts && ls shell | head -200");
    expect(r).toEqual([
      {
        kind: "read",
        tool: "cat",
        narrow: false,
        files: ["apps/web/src/routes/registry/farmer.ts", "apps/web/src/routes/registry/types.ts"],
        dirs: [],
      },
    ]);
  });

  it("cat then sed then grep in one line — read, narrow read, file search", () => {
    const r = kinds('cat routes/_layout.tsx; sed -n 14,75p shell/BottomBar.tsx; grep -n "nav\\.\\|entries" shell/Palette.tsx | head -40');
    expect(r.map((a) => [a.tool, a.kind, a.narrow])).toEqual([
      ["cat", "read", false],
      ["sed", "read", true],
      ["grep", "search", false],
    ]);
    expect(r[2]?.dirs).toEqual([]);
  });

  it("grep -rn over directories with --include is a tree search", () => {
    const r = kinds('grep -rn "403\\|isForbidden" src/shared/ui src/shared/lib --include=\'*.ts\' --include=\'*.tsx\' | grep -v "test\\." | head');
    expect(r).toEqual([{ kind: "search", tool: "grep", narrow: false, files: [], dirs: ["src/shared/ui", "src/shared/lib"] }]);
  });

  it("quoted alternation with | inside the pattern does not split the pipeline", () => {
    const r = kinds('grep -nE "FAIL|AssertionError|✗|×|Test Files" src/features/seed/queries.ts | head -20');
    expect(r).toHaveLength(1);
    expect(r[0]?.files).toEqual(["src/features/seed/queries.ts"]);
  });

  it("grep -rIl with --include in a worktree after cd is a search of that tree", () => {
    const r = classifyBashSourceAccess(
      `cd ${TAB}/apps && grep -rIl -i "sarcini\\|deadline" web/src --include=*.ts --include=*.tsx | head -20`,
      ROOT,
      ROOT,
    );
    expect(r[0]?.kind).toBe("search");
    expect(r[0]?.dirs).toEqual([`${TAB}/apps/web/src`]);
  });

  it("rg with a glob over `.` is a search of the whole tree; with no path it reads stdin (ADR-0120's gate)", () => {
    const r = kinds("rg -n --glob '*.tsx' \"PageHero\" .");
    expect(r).toEqual([{ kind: "search", tool: "rg", narrow: false, files: [], dirs: ["."] }]);
    expect(kinds("rg -n --glob '*.tsx' \"PageHero\"")).toEqual([]);
    expect(kinds('grep -rn "PageHero"')[0]?.dirs).toEqual(["."]);
  });

  it("rg restricted to markdown is not a source search", () => {
    expect(kinds("rg -n --glob '*.md' \"Scope of Done\" docs")).toEqual([]);
    expect(kinds('grep -n "0473" INDEX.md | cut -c1-120; grep -n "Scope of Done" -A 12 0475-x.md')).toEqual([]);
  });

  it("grep over a log in /tmp is not a source read", () => {
    expect(kinds('grep -nE "FAIL |Failed Tests|ERROR\\]" /tmp/d1-commit2.log | head')).toEqual([]);
    expect(kinds("tail -40 /tmp/d1-commit2.log | cut -c1-220")).toEqual([]);
  });

  it("build output and test reports are excluded even inside the project", () => {
    expect(kinds("sed -n 410,440p test-results/e2e-operator-user/error-context.md | grep -n button")).toEqual([]);
    expect(kinds("cat node_modules/react/index.js")).toEqual([]);
    expect(kinds("grep -rn foo graphify-out")).toEqual([]);
  });

  it("filters downstream of a pipe are never reads", () => {
    expect(kinds("cd apps/web && npx vitest run src/features/seed 2>&1 | tail -30")).toEqual([]);
    expect(kinds("pnpm test 2>&1 | grep -E 'FAIL|passed'")).toEqual([]);
    expect(kinds("git show HEAD:apps/web/src/x.tsx | grep -n OperatorKebab")).toEqual([]);
  });

  it("git, wc, ls never classify", () => {
    expect(kinds("git grep -l '^<<<<<<<'; git diff --name-only --diff-filter=U")).toEqual([]);
    expect(kinds("wc -l src/routes/platform/users.tsx; ls src/routes")).toEqual([]);
  });

  it("heredoc writes are not reads, and their bodies are never parsed", () => {
    const cmd = [
      "cat > src/features/farmnav/ParcelSuggestion.test.tsx <<'EOF'",
      'import { describe } from "vitest"; cat src/secret.ts | grep x',
      "EOF",
    ].join("\n");
    expect(kinds(cmd)).toEqual([]);
    const append = "cat >> src/features/calamity/queries.ts <<'EOF'\nexport const x = 1;\nEOF";
    expect(kinds(append)).toEqual([]);
  });

  it("sed -i is an edit, not a read", () => {
    expect(kinds("sed -i '' 's/<FormField required>/<FormField>/' src/routes/platform/managed-farm-claims.tsx")).toEqual([]);
  });

  it("head -n N and tail -n N are narrow; tail -n +N is not", () => {
    expect(kinds("head -40 REVIEW.md")).toEqual([]);
    expect(kinds("head -n 60 src/shared/ui/Icon.tsx")[0]?.narrow).toBe(true);
    expect(kinds("tail -n +200 src/shared/ui/Icon.tsx")[0]?.narrow).toBe(false);
  });

  it("a for loop over source files reads each through the loop variable", () => {
    const r = kinds("for f in src/a.ts src/b.ts; do cat $f; done");
    expect(r).toEqual([{ kind: "read", tool: "cat", narrow: false, files: ["src/a.ts", "src/b.ts"], dirs: [] }]);
  });

  it("xargs grep fed by find or git ls-files is a tree search", () => {
    expect(kinds("find src -name '*.tsx' | xargs grep -l useQuery")).toHaveLength(2);
    expect(kinds("git ls-files | xargs grep -n TODO")[0]?.kind).toBe("search");
  });

  it("find restricted to non-source names is not a source search", () => {
    expect(kinds("find docs -name '*.md' | head")).toEqual([]);
    expect(kinds("find apps/web/src -name '*.tsx'")[0]?.dirs).toEqual(["apps/web/src"]);
  });

  it("awk NR range is narrow, awk over a whole file is not", () => {
    expect(kinds("awk 'NR>=10 && NR<=50' src/x.ts")[0]?.narrow).toBe(true);
    expect(kinds("awk '{print $1}' src/x.ts")[0]?.narrow).toBe(false);
  });

  it("python heredocs that open source files are out of scope", () => {
    expect(kinds("python3 - <<'EOF'\ns=open('settings.tsx').read()\nEOF")).toEqual([]);
  });

  it("a path outside the project is never classified", () => {
    expect(kinds("cat /etc/hosts; sed -n 1,20p ~/x.ts")).toEqual([]);
  });
});
