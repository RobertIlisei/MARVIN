# tree-sitter-markdown — vendored (block-level grammar only)

Upstream: https://github.com/tree-sitter-grammars/tree-sitter-markdown
Commit:   c3570720f7f7bbad22fe96603f106276618e0cf5

## Why vendored

Upstream's `Package.swift` depends on `tree-sitter/swift-tree-sitter`
(the official binding from the tree-sitter org). MARVIN already pins
the **ChimeHQ** `SwiftTreeSitter` binding via the parent
`Package.swift`; adding the official one as a transitive dep is a
two-binding conflict — same fundamental shape as a duplicate-package
ID collision in any package manager.

Vendoring just the source files, without the upstream Package.swift,
sidesteps the conflict entirely. Our local target uses our ChimeHQ
binding.

## Scope of what's vendored

Only the **block-level** grammar (`tree-sitter-markdown/` in the
upstream repo). The matching **inline** grammar
(`tree-sitter-markdown-inline/`) handles emphasis / inline code /
inline links via tree-sitter's "language injection" mechanism;
combining the two requires our highlighter to participate in
injections, which the rest of the highlighter pipeline doesn't yet
do. Block-level alone covers headers, fenced code, lists,
blockquotes, tables, HTML blocks — the bulk of the visual win.
Inline grammar can be added in a follow-up if the gap matters.

## Refreshing

```
cd /tmp && rm -rf tree-sitter-markdown
git clone --depth 1 https://github.com/tree-sitter-grammars/tree-sitter-markdown.git
cp /tmp/tree-sitter-markdown/tree-sitter-markdown/src/{parser,scanner}.c macos/Vendored/tree-sitter-markdown/src/
cp /tmp/tree-sitter-markdown/tree-sitter-markdown/src/tree_sitter/*.h     macos/Vendored/tree-sitter-markdown/src/tree_sitter/
cp /tmp/tree-sitter-markdown/tree-sitter-markdown/bindings/swift/TreeSitterMarkdown/markdown.h macos/Vendored/tree-sitter-markdown/bindings/swift/TreeSitterMarkdown/
cp /tmp/tree-sitter-markdown/tree-sitter-markdown/queries/highlights.scm  macos/Vendored/tree-sitter-markdown/queries/
```

Update the commit line at the top of this file.
