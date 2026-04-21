"use client";

/**
 * File quick-open (⌘P). Fetches the project's tree on open, flattens to
 * a list of (path, relPath) entries, and fuzzy-filters against the
 * user's typed query. Arrow-keys navigate, Enter selects, Esc closes.
 *
 * Scoring is a lightweight subsequence match with bonuses for:
 *   - matches at path boundaries ('/' or start-of-string)
 *   - consecutive matches (tight contiguous runs beat scattered hits)
 * and a light penalty proportional to candidate length so short paths
 * bubble up when ties exist.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@marvin/ui/dialog";

interface TreeResponseNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeResponseNode[];
}
interface TreeResponse {
  root: string;
  tree: TreeResponseNode[];
}

interface Candidate {
  path: string;
  relPath: string;
  name: string;
}

interface Scored extends Candidate {
  score: number;
}

const MAX_RESULTS = 50;

function flatten(nodes: TreeResponseNode[], root: string): Candidate[] {
  const out: Candidate[] = [];
  const walk = (list: TreeResponseNode[]) => {
    for (const n of list) {
      if (n.type === "file") {
        const rel = n.path.startsWith(root)
          ? n.path.slice(root.length).replace(/^\/+/, "")
          : n.path;
        out.push({ path: n.path, relPath: rel, name: n.name });
      } else if (n.children) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/**
 * Subsequence-match score; higher is better. Returns -1 for no-match.
 * Dead-simple deliberately — good enough for project-scale (a few k files).
 */
function score(query: string, candidate: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let s = 0;
  let prevMatchIdx = -2;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      // Boundary bonus
      if (ci === 0 || c[ci - 1] === "/" || c[ci - 1] === "-" || c[ci - 1] === "_" || c[ci - 1] === ".") {
        s += 6;
      } else {
        s += 1;
      }
      // Consecutive-match bonus
      if (ci === prevMatchIdx + 1) s += 3;
      prevMatchIdx = ci;
      qi++;
    }
  }
  if (qi < q.length) return -1;
  // Length penalty — shorter wins on ties.
  s -= c.length / 200;
  // Strong bonus when the filename (last segment) contains the query
  // contiguously. Keeps "readme" above "a/b/readme/foo" at the same token count.
  const last = c.lastIndexOf("/");
  const base = last >= 0 ? c.slice(last + 1) : c;
  if (base.includes(q)) s += 20;
  return s;
}

export function QuickOpen({
  cwd,
  open,
  onOpenChange,
  onSelect,
}: {
  cwd: string;
  open: boolean;
  onOpenChange(o: boolean): void;
  onSelect(absPath: string): void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open || !cwd) return;
    let cancelled = false;
    setLoading(true);
    fetch(`/api/files/tree?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TreeResponse | null) => {
        if (cancelled || !d) return;
        setCandidates(flatten(d.tree, d.root));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Next-tick focus so Dialog's auto-focus doesn't race us.
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const results: Scored[] = useMemo(() => {
    if (!query.trim()) {
      return candidates.slice(0, MAX_RESULTS).map((c) => ({ ...c, score: 0 }));
    }
    const scored: Scored[] = [];
    for (const c of candidates) {
      const s = score(query.trim(), c.relPath);
      if (s >= 0) scored.push({ ...c, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS);
  }, [query, candidates]);

  // Keep activeIdx within range.
  useEffect(() => {
    if (activeIdx >= results.length) setActiveIdx(Math.max(0, results.length - 1));
  }, [results.length, activeIdx]);

  // Scroll active row into view.
  useEffect(() => {
    const ul = listRef.current;
    if (!ul) return;
    const row = ul.children.item(activeIdx) as HTMLElement | null;
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const commit = (idx: number) => {
    const hit = results[idx];
    if (!hit) return;
    onSelect(hit.path);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 p-0 sm:max-w-xl"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx((i) => Math.min(results.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            commit(activeIdx);
          } else if (e.key === "Escape") {
            onOpenChange(false);
          }
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Quick open</DialogTitle>
          <DialogDescription>
            Fuzzy-search files in the current project and open one.
          </DialogDescription>
        </DialogHeader>
        <div className="border-b border-[color:var(--color-border)] px-3 py-2.5">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            placeholder="go to file… (↑↓ to move · ↵ to open · esc to close)"
            className="w-full bg-transparent font-mono text-[13px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-fg-faint)]"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="scroll-thin max-h-[48vh] min-h-[12rem] overflow-y-auto px-1 py-1">
          {loading ? (
            <div className="px-3 py-4 font-mono text-[11px] text-[color:var(--color-fg-faint)]">
              reading tree…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-4 font-mono text-[11px] text-[color:var(--color-fg-faint)]">
              no matches
            </div>
          ) : (
            <ul ref={listRef}>
              {results.map((r, i) => {
                const active = i === activeIdx;
                const parent = r.relPath.replace(/\/?[^/]+$/, "");
                return (
                  <li
                    key={r.path}
                    className={`flex items-center gap-3 rounded px-3 py-1.5 font-mono text-[12px] cursor-pointer transition ${
                      active
                        ? "bg-[color:var(--color-accent-glow)] text-[color:var(--color-fg)]"
                        : "text-[color:var(--color-fg)]/90 hover:bg-[color:var(--color-bg-elev)]/60"
                    }`}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={() => commit(i)}
                  >
                    <span className="truncate">{r.name}</span>
                    {parent && (
                      <span className="ml-auto truncate pl-4 text-[11px] text-[color:var(--color-fg-faint)]">
                        {parent}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
