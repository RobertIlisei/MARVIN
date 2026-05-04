// ContentView — Phase 0 placeholder window.
//
// Three states wired to HealthMonitor.state:
//   • connecting — soft "starting up" message + spinner
//   • online     — minimal "MARVIN is up" panel summarizing what
//                  the sidecar reported (auth mode, model, data
//                  dir). Phase 1 replaces this with a WKWebView
//                  loading localhost:3030.
//   • offline    — the failure reason, plus a copyable command for
//                  starting the sidecar.
//
// Visual style is deliberately minimal — Phase 0's job is to prove
// the bootstrap works, not to look like the final shell. Theme-
// aware colors come from NSColor system semantics so light / dark
// mode just work.

import SwiftUI

struct ContentView: View {
    @Environment(HealthMonitor.self) private var health

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()
            switch health.state {
            case .connecting:
                connectingView
            case .online(let snapshot):
                onlineView(snapshot)
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
    private func onlineView(_ s: SidecarHealth) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(Color.green)
                    .frame(width: 10, height: 10)
                Text("MARVIN is up")
                    .font(.title3.weight(.semibold))
            }
            Divider()
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    label("URL", "http://localhost:3030")
                    label("auth", s.auth?.mode ?? "unknown")
                    label("model", s.model ?? "unknown")
                    label("data dir", s.dataDir ?? "unknown")
                }
                .font(.body.monospaced())
            }
            Spacer(minLength: 16)
            Text("Phase 1 will replace this view with the live MARVIN UI.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
        }
        .padding(28)
        .frame(maxWidth: 520, maxHeight: .infinity, alignment: .topLeading)
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

    // MARK: - Helpers

    private func label(_ k: String, _ v: String) -> some View {
        HStack(spacing: 12) {
            Text(k)
                .frame(width: 80, alignment: .leading)
                .foregroundStyle(.secondary)
            Text(v)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
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
