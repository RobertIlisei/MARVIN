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
    ],
    targets: [
        .executableTarget(
            name: "MARVIN",
            dependencies: [
                .product(name: "STTextView", package: "STTextView"),
                .product(name: "SwiftTreeSitter", package: "SwiftTreeSitter"),
                .product(name: "TreeSitterSwift", package: "tree-sitter-swift"),
                .product(name: "TreeSitterTypeScript", package: "tree-sitter-typescript"),
            ],
            // SPM looks for Sources/MARVIN by default; we keep
            // sources at apps/macos/MARVIN to match the Xcode
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
    ]
)
