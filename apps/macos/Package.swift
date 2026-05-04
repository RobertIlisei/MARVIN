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

import PackageDescription

let package = Package(
    name: "MARVIN",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "MARVIN", targets: ["MARVIN"]),
    ],
    targets: [
        .executableTarget(
            name: "MARVIN",
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
