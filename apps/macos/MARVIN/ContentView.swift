// ContentView — Phase 1a window.
//
// Three states wired to HealthMonitor.state:
//   • connecting — soft "starting up" message + spinner
//   • online     — full-bleed WKWebView pointed at the sidecar
//                  (`http://localhost:3030`). The web app renders
//                  here unchanged. Later phases replace pieces of
//                  this WebView with native AppKit views.
//   • offline    — the failure reason, plus a copyable command for
//                  starting the sidecar.
//
// Phase 1a tradeoff (intentional, documented for future iteration):
// every transition online → offline → online tears down the
// WebView, losing scroll position / form input / chat focus. The
// alternative — keep the WebView always mounted under a ZStack
// overlay — is straightforward but means the WebView attempts to
// load `localhost:3030` while the sidecar is still booting, which
// shows WebKit's ugly "can't connect" error page on cold start.
// Trading the cold-start ugliness for the rare-mid-session-drop
// regression. Re-evaluate if the drop becomes painful in practice.
//
// Visual style is deliberately minimal — Phase 1a is about proving
// the WebView island works inside the SwiftUI shell. Native menu
// bar, toolbar, window-state restoration land in 1b/1c/1d.

import SwiftUI

/// Hardcoded for Phase 1a — single MARVIN install per machine,
/// `bin/marvin` always uses port 3030. Phase 2+ may move this into
/// a Settings surface so multi-port dev setups work, but that's
/// premature today.
private let sidecarURL = URL(string: "http://localhost:3030")!

struct ContentView: View {
    @Environment(HealthMonitor.self) private var health

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            switch health.state {
            case .connecting:
                connectingView
            case .online:
                // Phase 1a: full-bleed WebView. Once the sidecar is
                // reachable, hand the entire content area over to
                // the existing web UI. The auth/model summary that
                // Phase 0 rendered is discoverable via `bin/marvin
                // status` from the terminal — the SwiftUI app's
                // job here is to host the UI, not duplicate its
                // status view.
                WebView(url: sidecarURL)
                    .ignoresSafeArea()
            case .offline(let reason):
                offlineView(reason: reason)
            }
        }
        .frame(minWidth: 480, minHeight: 320)
    }

    // MARK: - States

    private var connectingView: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Connecting to MARVIN sidecar…")
                .font(.body.monospaced())
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func offlineView(reason: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 10, height: 10)
                Text("Sidecar not reachable")
                    .font(.title3.weight(.semibold))
            }
            Text(reason)
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Divider()
            VStack(alignment: .leading, spacing: 6) {
                Text("Start the sidecar")
                    .font(.callout.weight(.semibold))
                CodeBlock(text: "bin/marvin start")
                Text("Run from the MARVIN repo root. The Node server bound to port 3030 is what this app talks to.")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("Reconnect") {
                    Task { await health.refreshNow() }
                }
                .keyboardShortcut("r", modifiers: [.command])
            }
        }
        .padding(28)
        .frame(maxWidth: 520, maxHeight: .infinity, alignment: .topLeading)
    }

}

/// Tiny inline code block — selectable, monospaced, subtly framed.
/// Avoids pulling in SwiftUI Text styling tricks the user might
/// override globally later.
private struct CodeBlock: View {
    let text: String
    var body: some View {
        Text(text)
            .font(.body.monospaced())
            .textSelection(.enabled)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(Color(nsColor: .separatorColor), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

// SwiftUI #Preview macros aren't checked in here because the
// `PreviewsMacros` plugin is shipped with Xcode and isn't available
// to plain Command Line Tools / `swift build`. CI compiles via
// SPM (no Xcode), so a #Preview block would break that path. Add
// previews locally when iterating in Xcode and don't commit them.
