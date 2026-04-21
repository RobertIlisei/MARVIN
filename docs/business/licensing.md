# Licensing

**Status: MIT (decided 2026-04-21).**

MARVIN's `LICENSE` file at the repo root carries the full MIT text.
`package.json` declares `"license": "MIT"`.

## Practical effect

Everything MIT grants:

- **Use.** Run MARVIN locally, in CI, wherever.
- **Modify.** Fork, change, rebuild.
- **Redistribute.** Publish modified or unmodified copies.
- **Sublicense / sell.** Bundle into commercial products if you want.

Two obligations:

1. Keep the copyright notice + MIT text in any copy or substantial portion you redistribute.
2. Accept that the software is "as is" — no warranty.

Everything else is on the table.

## How we got here

The rest of this page is the historical reasoning for picking MIT over
the alternatives. Kept so the choice is auditable — the ADR analogue
for a legal decision. Summary:

- MARVIN's entire dependency surface (Next.js, React, xterm.js, Monaco, Tauri plugins we touch) is MIT or Apache 2.0. Matching MIT keeps the outbound story simple.
- The project is one author + one AI pair. Copyleft enforcement overhead would exceed any protection benefit.
- No patents to worry about — MARVIN is glue around Anthropic's SDK. Apache 2.0's patent grant would be precautionary rather than substantive.
- MIT's brevity matches the project's character. Every ADR has favoured the simpler option.

## Alternatives considered (historical)

Under consideration through 2026-04-20:

### MIT License

*Plain text: "do whatever you want, just keep this notice."*

- **Pros:** Simplest, most permissive, maximum adoption velocity. No patent retaliation clause means compatible with everything.
- **Cons:** Zero reciprocity. A well-capitalized company could fork, bundle, rebrand, and sell without contributing back.

### Apache 2.0

*Like MIT but with an explicit patent grant and a trademark-handling clause.*

- **Pros:** Permissive + patent protection. Increasingly the "default" open-source license for new projects.
- **Cons:** Slightly more legal weight than MIT. Overkill for a small project with no patents.

### MPL 2.0 (Mozilla Public License)

*File-level copyleft — modifications to MPL files must stay MPL, but you can mix with proprietary code around them.*

- **Pros:** Reciprocity on the MARVIN files themselves. A fork has to share MARVIN-code improvements; unrelated proprietary additions stay proprietary.
- **Cons:** More complex than MIT/Apache. Users need to understand the file-level boundary.

### GPL-family (LGPL, AGPL)

*Strong copyleft — everything that links to MARVIN inherits the license.*

- **Pros:** Maximum reciprocity.
- **Cons:** Incompatible with most proprietary toolchains. Would cut MARVIN off from commercial users who might otherwise contribute.

## Decision (2026-04-21)

**MIT.** For the reasons above.

Apache 2.0 was the close second — its patent grant is nice to have — but MARVIN has no patentable surface today, so the extra legal weight was protection against a threat that doesn't exist. Revisit if that changes (a new ADR would supersede this note).

## Contributor Inbound License

Contributions submitted via PR are offered under the same MIT license, inbound=outbound — the standard open-source default. No separate CLA.

## Related

- [Vision](./vision.md) — why MARVIN isn't a hosted product.
- [Cost model](./cost-model.md) — the financial side.
- [Contributing](../development/contributing.md)
- MARVIN's dependencies are licensed separately — Next.js (MIT), React (MIT), Anthropic SDK (Apache 2.0), xterm.js (MIT), monaco-editor (MIT), etc.
