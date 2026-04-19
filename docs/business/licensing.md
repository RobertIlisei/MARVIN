# Licensing

**Status: not yet specified.**

MARVIN's GitHub repository does not currently carry a LICENSE file. This is a deliberate pause, not an oversight. The decision is pending.

## Current practical effect

Without an explicit license, default copyright applies:

- The code is the author's (@robertilisei's) copyrighted work.
- Cloning the repo to your machine for personal use is generally acceptable (fair use, at-rest only).
- **Commercial use, redistribution, modification-and-publication, or derivative works are NOT granted.** Nothing stops you reading the code; you don't have rights to build on it publicly.
- Contributions submitted via PR are implicitly offered under the eventual license MARVIN will ship under.

If you want to use MARVIN for anything beyond "clone and run on your own machine," wait for the license decision or open an issue to ask.

## What MARVIN will likely land on

Under active consideration:

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

## Probable landing spot

**MIT or Apache 2.0.** MARVIN is small enough that copyleft enforcement would be wasted effort; the value of adoption + contributions outweighs the value of forcing reciprocity.

MIT has the edge on simplicity; Apache 2.0 has the edge on patent safety. Decision likely comes down to whether anyone files a patent issue, which is unlikely for a tool that's mostly glue around someone else's SDK.

## Contributor Inbound License

When the project license lands, contributors' PRs will be treated as offered under the same license, inbound=outbound (the standard open-source default). No separate CLA planned.

## Related

- [Vision](./vision.md) — why MARVIN isn't a hosted product.
- [Cost model](./cost-model.md) — the financial side.
- [Contributing](../development/contributing.md)
- MARVIN's dependencies are licensed separately — Next.js (MIT), React (MIT), Anthropic SDK (Apache 2.0), xterm.js (MIT), monaco-editor (MIT), etc.
