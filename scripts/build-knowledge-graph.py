#!/usr/bin/env python3
"""
Build the per-project knowledge graph (ADR-0028, development branch).

Walks markdown and Asciidoc-like text files (docs/, ADRs, top-level READMEs,
.marvin/memory.md, root CLAUDE.md) and produces a NetworkX graph of:

  - File-level nodes (one per doc)
  - Heading nodes (every # / ## / ### …) parented to their containing file
    and to ancestor headings
  - Cross-doc link edges (relative markdown links between corpus files)
  - Community detection via graphify.cluster (same algorithm as the code graph)

Writes to <workDir>/graphify-out/knowledge/graph.json in the same node-link
JSON shape graphify itself produces, so MARVIN's read-graph.ts can parse it
without a separate codec.

Honours <workDir>/.graphifyignore (the same file the code graph respects).

Cost: free. No LLM. Semantic depth is the user's decision — invoke
`/graphify docs` to layer it on later.

Usage:
  python3 build-knowledge-graph.py <workDir> [--inputs <relpath> ...]

Defaults inputs to:
  CLAUDE.md  README.md  docs/  .marvin/memory.md
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from hashlib import blake2b
from pathlib import Path

try:
    import networkx as nx  # type: ignore
    from graphify.cluster import cluster  # type: ignore
    from graphify.detect import _is_ignored, _load_graphifyignore  # type: ignore
except ImportError as e:
    print(
        f"error: missing graphify Python package — {e}\n"
        "install with: python3 -m pip install graphifyy",
        file=sys.stderr,
    )
    sys.exit(2)


HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$", re.M)
LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\n]+)\)")
SLUG_RE = re.compile(r"[^a-z0-9]+")
TEXT_SUFFIXES = {".md", ".markdown", ".mdx", ".rst", ".adoc", ".txt"}


def slugify(text: str) -> str:
    return SLUG_RE.sub("-", text.lower()).strip("-")[:80]


def short_id(s: str, n: int = 12) -> str:
    return blake2b(s.encode("utf-8"), digest_size=n).hexdigest()


def relpath(p: Path, root: Path) -> str:
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


def collect_files(root: Path, inputs, patterns):
    out = []
    seen = set()
    for inp in inputs:
        if not inp.exists():
            continue
        if inp.is_file():
            if inp.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if patterns and _is_ignored(inp, root, patterns):
                continue
            if inp not in seen:
                seen.add(inp)
                out.append(inp)
            continue
        for child in inp.rglob("*"):
            if not child.is_file():
                continue
            if child.suffix.lower() not in TEXT_SUFFIXES:
                continue
            if patterns and _is_ignored(child, root, patterns):
                continue
            if child in seen:
                continue
            seen.add(child)
            out.append(child)
    return sorted(out)


def parse_markdown(path: Path, root: Path):
    rel = relpath(path, root)
    file_id = f"file::{short_id(rel)}"
    nodes = [
        {
            "id": file_id,
            "label": path.name,
            "kind": "doc_file",
            "source_file": rel,
        }
    ]
    edges = []
    raw = path.read_text(encoding="utf-8", errors="replace")

    parent_stack = [(0, file_id)]
    seen_anchors = set()
    heading_ids_by_slug = {}
    for m in HEADING_RE.finditer(raw):
        level = len(m.group(1))
        text = m.group(2).strip()
        if not text:
            continue
        anchor = slugify(text)
        base_anchor = anchor
        salt = 2
        while anchor in seen_anchors:
            anchor = f"{base_anchor}-{salt}"
            salt += 1
        seen_anchors.add(anchor)
        heading_id = f"heading::{short_id(rel + '::' + anchor)}"
        heading_ids_by_slug[anchor] = heading_id
        nodes.append(
            {
                "id": heading_id,
                "label": text,
                "kind": "heading",
                "source_file": rel,
            }
        )
        while parent_stack and parent_stack[-1][0] >= level:
            parent_stack.pop()
        parent_id = parent_stack[-1][1] if parent_stack else file_id
        edges.append(
            {
                "source": parent_id,
                "target": heading_id,
                "relation": "contains",
                "confidence": "EXTRACTED",
            }
        )
        parent_stack.append((level, heading_id))

    for m in LINK_RE.finditer(raw):
        target = m.group(2).strip()
        if not target:
            continue
        if target.startswith("#"):
            anchor = target.lstrip("#").lower()
            slug = slugify(anchor)
            if slug in heading_ids_by_slug:
                edges.append(
                    {
                        "source": file_id,
                        "target": heading_ids_by_slug[slug],
                        "relation": "references",
                        "confidence": "EXTRACTED",
                    }
                )
            continue
        if target.startswith(("http://", "https://", "mailto:", "tel:")):
            continue
        clean = target.split("#")[0]
        if not clean:
            continue
        try:
            resolved = (path.parent / clean).resolve()
        except (OSError, RuntimeError):
            continue
        if not resolved.exists() or not resolved.is_file():
            continue
        if resolved.suffix.lower() not in TEXT_SUFFIXES:
            continue
        rel_target = relpath(resolved, root)
        target_id = f"file::{short_id(rel_target)}"
        edges.append(
            {
                "source": file_id,
                "target": target_id,
                "relation": "links_to",
                "confidence": "EXTRACTED",
            }
        )

    return nodes, edges


def assemble_graph(all_nodes, all_edges):
    G = nx.Graph()
    node_ids = set()
    for n in all_nodes:
        if n["id"] in node_ids:
            continue
        node_ids.add(n["id"])
        attrs = {k: v for k, v in n.items() if k != "id"}
        G.add_node(n["id"], **attrs)
    for e in all_edges:
        s = e["source"]
        t = e["target"]
        if s not in node_ids or t not in node_ids:
            continue
        G.add_edge(
            s,
            t,
            relation=e.get("relation", "related"),
            confidence=e.get("confidence", "EXTRACTED"),
        )
    return G


def to_node_link(G, community_of):
    nodes_out = []
    for nid, attrs in G.nodes(data=True):
        n = {"id": nid}
        n.update(attrs)
        if nid in community_of:
            n["community"] = community_of[nid]
        nodes_out.append(n)
    links_out = []
    for u, v, attrs in G.edges(data=True):
        links_out.append(
            {
                "source": u,
                "target": v,
                "relation": attrs.get("relation", "related"),
                "confidence": attrs.get("confidence", "EXTRACTED"),
            }
        )
    return {
        "directed": False,
        "multigraph": False,
        "graph": {
            "kind": "marvin-knowledge",
            "built_at": datetime.now(timezone.utc).isoformat(),
        },
        "nodes": nodes_out,
        "links": links_out,
        "hyperedges": [],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("workDir", type=Path)
    parser.add_argument("--inputs", nargs="+", default=None)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    root = args.workDir.resolve()
    if not root.is_dir():
        print(f"error: workDir does not exist or is not a directory: {root}", file=sys.stderr)
        return 1

    inputs_rel = args.inputs or ["CLAUDE.md", "README.md", "docs", ".marvin/memory.md"]
    inputs = [root / p for p in inputs_rel]

    patterns = _load_graphifyignore(root)
    files = collect_files(root, inputs, patterns)
    if not files:
        print(
            f"warning: no markdown/doc files found under: {' '.join(inputs_rel)}\n"
            "  knowledge graph not built — nothing to extract.",
            file=sys.stderr,
        )
        return 0

    print(f"knowledge-graph: scanning {len(files)} file(s) under {root}")
    all_nodes = []
    all_edges = []
    for f in files:
        nodes, edges = parse_markdown(f, root)
        all_nodes.extend(nodes)
        all_edges.extend(edges)

    print(f"  raw extraction: {len(all_nodes)} nodes · {len(all_edges)} edges")
    G = assemble_graph(all_nodes, all_edges)
    print(f"  assembled: {G.number_of_nodes()} nodes · {G.number_of_edges()} edges")

    try:
        communities = cluster(G)
    except Exception as e:
        print(f"  cluster() failed ({e}) — writing graph without communities", file=sys.stderr)
        communities = {}
    community_of = {}
    for cid, members in communities.items():
        for nid in members:
            community_of[nid] = cid
    if communities:
        print(f"  communities: {len(communities)}")

    out_path = args.out or (root / "graphify-out" / "knowledge" / "graph.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = to_node_link(G, community_of)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"  wrote: {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
