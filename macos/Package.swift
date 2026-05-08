// swift-tools-version: 5.10
//
// Optional SPM mirror — `swift build` smoke-checks the sources without
// needing full Xcode. Useful for CI and headless verification (the
// sandbox MARVIN runs in often only has the Command Line Tools, not
// Xcode). Does NOT produce a runnable .app bundle — that path is
// `xcodegen generate && xcodebuild`. See BUILD.md.
//
// The Xcode project (manifested via project.yml) is the source of
// truth for shipping the app; this Package.swift exists so PRs can
// gate-check Swift compile errors without contributors needing
// Xcode installed.
//
// ## Why we DO list runtime dependencies here (post-Phase 5)
//
// Through Phases 1-4 the macOS target had zero external Swift deps —
// it was all Foundation / AppKit / SwiftUI / MetalKit / WebKit. Phase 5
// ports the embedded surfaces (Monaco / xterm.js → native), and the
// best-of-breed Swift libraries for those (STTextView, SwiftTreeSitter,
// SwiftTerm) are SPM packages. We add them as real dependencies so
// `swift build` resolves + caches them on first build, and so the
// SPM fallback path in `bin/marvin install-macos-app` produces a
// runnable `.app` without needing Xcode.
//
// project.yml mirrors the same packages under `packages:` so the
// xcodegen+xcodebuild path (preferred when full Xcode is installed)
// produces an equivalent build. Drift between the two manifests IS
// the bug — keep them aligned.

import PackageDescription

let package = Package(
    name: "MARVIN",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "MARVIN", targets: ["MARVIN"]),
        .executable(name: "MARVINTests", targets: ["MARVINTests"]),
    ],
    dependencies: [
        // Phase 5b — STTextView is the AppKit text view we use for the
        // native file viewer. TextKit 2 backed; ships line numbers,
        // soft wrap, and the attribute APIs the tree-sitter highlighter
        // writes through. MIT licensed; krzyzanowskim is a long-time
        // Apple-platform OSS maintainer (CryptoSwift, etc.).
        //
        // Pin to a known-good minor — we don't auto-take majors because
        // STTextView's API surface is still settling and a major bump
        // could re-ship the public types we wrap. Bump deliberately
        // when 5c lands editing.
        .package(
            url: "https://github.com/krzyzanowskim/STTextView.git",
            from: "1.0.0"
        ),

        // Phase 5b.2 — tree-sitter Swift binding from ChimeHQ. The
        // SwiftTreeSitter wrapper exposes the C tree-sitter library
        // as Swift (Parser / Language / Tree / Query / QueryCursor)
        // and is the foundation used by Neon, Chime, and most other
        // Swift editor projects. MIT licensed; ChimeHQ is also the
        // maintainer of TextStory + Neon + several other Apple-
        // platform editor frameworks.
        .package(
            url: "https://github.com/ChimeHQ/SwiftTreeSitter.git",
            from: "0.9.0"
        ),

        // Phase 5b.2 — per-language tree-sitter packages. Each one
        // bundles the C parser source + a `queries/highlights.scm`
        // file via SPM's resource pipeline. Adding a new language
        // is: SPM dep + one entry in SyntaxHighlighter.languageFor.
        //
        // - tree-sitter-swift uses alex-pinkus's `with-generated-files`
        //   branch — the upstream repo only ships generator inputs,
        //   not the generated parser.c, so the pre-generated branch
        //   is the SPM-friendly path.
        // - tree-sitter-typescript covers both .ts and .tsx via two
        //   library products (TreeSitterTypeScript + TreeSitterTSX).
        //
        // Phase 5b.3 will add tree-sitter-python / -go / -rust /
        // -markdown alongside the same SyntaxHighlighter switch.
        .package(
            url: "https://github.com/alex-pinkus/tree-sitter-swift.git",
            branch: "with-generated-files"
        ),
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-typescript.git",
            from: "0.23.0"
        ),

        // Phase 5b.3 — Go + Rust language packages. Same SPM-
        // friendly shape as tree-sitter-typescript: pre-generated
        // parser.c (+ scanner.c when the language has an external
        // scanner) + queries/highlights.scm shipped as resources,
        // public C header exposes the `tree_sitter_<lang>()`
        // factory.
        //
        // Two languages from the ADR-0020 5b list are deferred
        // here — Python and Markdown:
        //
        // - Python: tree-sitter-python's Package.swift uses a
        //   runtime `FileManager.fileExists("src/scanner.c")` to
        //   conditionally add the external scanner source. The
        //   relative path resolves against SPM's cwd, which is the
        //   transitively-loading package (i.e. MARVIN), not the
        //   tree-sitter-python checkout. The check fails and
        //   scanner.c isn't compiled, so the linker fails with
        //   undefined `_tree_sitter_python_external_scanner_*`
        //   symbols. Standalone builds against tree-sitter-python
        //   work fine. Workarounds (vendor + patch / fork pin /
        //   wait for upstream fix) all need their own commit; Go
        //   + Rust don't hit this and ship cleanly today.
        //
        // - Markdown: tree-sitter-markdown depends on
        //   tree-sitter/swift-tree-sitter (a different Swift
        //   binding than the ChimeHQ SwiftTreeSitter we already
        //   pin) and ships a dual-grammar block + inline pair.
        //   Both wrinkles are real but solvable; user-visible
        //   upside is small (markdown is mostly prose) so it gets
        //   pushed to a later iteration of 5b.
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-go.git",
            from: "0.23.0"
        ),
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-rust.git",
            from: "0.23.0"
        ),

        // Phase 5e — broad file-type recognition. Each upstream ships
        // pre-generated parser.c + queries/highlights.scm + a
        // SPM-shaped Package.swift exposing a TreeSitter<Lang>
        // product. Extending the highlighter to a new language is:
        //   1. add the SPM dep here + in project.yml
        //   2. add the C factory binding + enum case in SyntaxHighlighter
        //   3. drop highlights.scm into Resources/Queries
        //
        // Languages added in this batch — focused on what shows up
        // in real-world projects (config / docs / web / native):
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-json.git",
            from: "0.24.0"
        ),
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-html.git",
            from: "0.23.0"
        ),
        // tree-sitter-css is deferred — its Package.swift uses the
        // same `FileManager.fileExists("src/scanner.c")` runtime
        // probe that defeats the SPM transitive-load case (the path
        // resolves against MARVIN's cwd, not the package's), so the
        // external scanner symbols come back undefined at link
        // time. Same fix needed as tree-sitter-python: vendor +
        // patch, fork pin, or wait for upstream. CSS files fall
        // back to the html parser today, which gives "tag-like"
        // highlighting — degraded but not blank.
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-c.git",
            from: "0.23.0"
        ),
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-cpp.git",
            from: "0.23.0"
        ),
        .package(
            url: "https://github.com/tree-sitter/tree-sitter-bash.git",
            from: "0.23.0"
        ),
    ],
    targets: [
        // ADR-0022: pure-logic library. Holds helpers that have no UI
        // and no @MainActor coupling — context-pressure parsing /
        // band classification, and the Scope-met sentinel detector.
        // Living in a library target lets `MARVINTests` link them
        // (executable targets cannot be linked from another target,
        // even with @testable import). The MARVIN executable depends
        // on this too so the production code path is the same as the
        // test code path.
        .target(
            name: "MARVINLogic",
            path: "MARVINLogic"
        ),
        .executableTarget(
            name: "MARVIN",
            dependencies: [
                "MARVINLogic",
                .product(name: "STTextView", package: "STTextView"),
                .product(name: "SwiftTreeSitter", package: "SwiftTreeSitter"),
                .product(name: "TreeSitterSwift", package: "tree-sitter-swift"),
                .product(name: "TreeSitterTypeScript", package: "tree-sitter-typescript"),
                .product(name: "TreeSitterGo", package: "tree-sitter-go"),
                .product(name: "TreeSitterRust", package: "tree-sitter-rust"),
                .product(name: "TreeSitterJSON", package: "tree-sitter-json"),
                .product(name: "TreeSitterHTML", package: "tree-sitter-html"),
                .product(name: "TreeSitterC", package: "tree-sitter-c"),
                .product(name: "TreeSitterCPP", package: "tree-sitter-cpp"),
                .product(name: "TreeSitterBash", package: "tree-sitter-bash"),
            ],
            // SPM looks for Sources/MARVIN by default; we keep
            // sources at macos/MARVIN to match the Xcode
            // project layout, so point SPM at the same dir.
            path: "MARVIN",
            // Info.plist is consumed by Xcode via project.yml,
            // not by SPM. Exclude it so `swift build` doesn't
            // try to pull it into the binary. Resources/ is also
            // excluded — the SPM fallback path in `bin/marvin
            // install-macos-app` copies AppIcon.icns + the SVGs
            // directly into Contents/Resources/, so SPM doesn't
            // need to bundle them itself.
            exclude: [
                "Info.plist",
                "Resources",
            ],
            resources: []
        ),
        // ADR-0022: pure-helper tests for the context-pressure
        // segment + Scope-met detector. We use a tiny executable
        // target with hand-rolled assertions rather than XCTest /
        // Swift Testing because the user's local toolchain
        // (Command Line Tools, no Xcode.app) doesn't link those
        // frameworks via SPM. The functions exercised here have no
        // UI and no @MainActor annotation, so a plain executable is
        // sufficient. Run via `swift run MARVINTests` — exit code 0
        // means all assertions passed.
        .executableTarget(
            name: "MARVINTests",
            dependencies: ["MARVINLogic"],
            path: "MARVINTests"
        ),
    ]
)
