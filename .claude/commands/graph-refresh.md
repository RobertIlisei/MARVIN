---
description: Rebuild both MARVIN graphs (code + knowledge) after a milestone.
---

Refresh MARVIN's two graphs so the next session starts with accurate
structural and documentation context. Per ADR-0028 and CLAUDE.md ▸
graphify section, the code graph auto-rebuilds on commit but the
knowledge graph is manual — keeping them in sync is a habit, not a
hook.

Run both in sequence:

1. `bin/marvin knowledge-graph .` — rebuilds the knowledge graph
   (`graphify-out/knowledge/graph.json`) from `docs/`, ADRs,
   `README.md`, `CLAUDE.md`, `.marvin/memory.md`. AST-only, no LLM cost.
2. `/graphify . --update` — rebuilds the code graph
   (`graphify-out/graph.json`) from source files. AST-only, no LLM
   cost.

After both finish, run `graph_summary` (both scopes) to confirm node
counts moved and surface any new god nodes that drifted into the list.
