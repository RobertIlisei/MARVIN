// AboutView — replaces SwiftUI's default About panel with one that
// shows live sidecar info pulled from HealthMonitor. Useful during
// the migration evaluation period: tells you at a glance which
// MARVIN you're looking at (Tauri vs Swift) and what the sidecar
// is currently reporting (auth mode, model, data dir).
//
// Mounted as a separate Window scene in MARVINApp.swift, opened via
// the App menu's About item (CommandGroup(replacing: .appInfo)).
// Phase 1+: if we add settings, status, etc. as their own panels,
// they follow the same Window-scene + openWindow(id:) pattern.

import SwiftUI

struct AboutView: View {
    @Environment(HealthMonitor.self) private var health

    /// Pulled from the bundle's Info.plist so the About panel stays
    /// in sync with the actual installed build — no hardcoded
    /// version strings to drift.
    private var versionLine: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "\(short) (\(build))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                if let appIcon = NSImage(named: "NSApplicationIcon") {
                    Image(nsImage: appIcon)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 64, height: 64)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("MARVIN")
                        .font(.title.weight(.semibold))
                    Text("Swift native shell · Phase 1c")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text("v\(versionLine)")
                        .font(.body.monospaced())
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                }
                Spacer()
            }

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text("Sidecar")
                    .font(.callout.weight(.semibold))
                sidecarBlock
            }

            Divider()

            HStack(spacing: 4) {
                Text("Migration plan:")
                    .foregroundStyle(.secondary)
                Link("ADR-0016", destination: URL(string: "https://github.com/RobertIlisei/MARVIN/blob/main/docs/decisions/0016-swift-migration.md")!)
            }
            .font(.footnote)

            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(width: 460, height: 380)
    }

    @ViewBuilder
    private var sidecarBlock: some View {
        switch health.state {
        case .connecting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("connecting to http://localhost:3030…")
                    .font(.body.monospaced())
                    .foregroundStyle(.secondary)
            }
        case .online(let s):
            VStack(alignment: .leading, spacing: 4) {
                aboutRow("URL", "http://localhost:3030")
                aboutRow("auth", s.auth?.mode ?? "unknown")
                aboutRow("model", s.model ?? "unknown")
                aboutRow("data dir", s.dataDir ?? "unknown")
                if let bin = s.claudeBinary {
                    aboutRow("claude", bin)
                }
            }
            .font(.body.monospaced())
        case .offline(let reason):
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 8, height: 8)
                    Text("offline")
                        .font(.body.monospaced())
                }
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func aboutRow(_ k: String, _ v: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(k)
                .frame(width: 70, alignment: .leading)
                .foregroundStyle(.secondary)
            Text(v)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }
}
