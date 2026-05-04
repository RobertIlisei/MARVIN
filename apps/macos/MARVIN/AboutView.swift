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
    @Environment(MarvinBridge.self) private var bridge

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

            // Phase 1d.8 — show the active project + branch the
            // bridge knows about. Hidden when no project is active
            // so the About panel collapses cleanly. workDir is the
            // most useful field here — surfaces the absolute path
            // that's only otherwise visible in the BranchBadge
            // tooltip in the web TopBar.
            if bridge.projectName != nil {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Active project")
                        .font(.callout.weight(.semibold))
                    projectBlock
                }
            }

            // Phase 1d.15 — show the user-selected models when set.
            // Sidecar's defaultModel still appears in the Sidecar
            // section above; this section reflects the user's pick
            // (which the web app's model picker writes to
            // localStorage and the bridge mirrors). Hidden when
            // nothing's been selected — Sidecar default is the
            // implicit answer in that case.
            if bridge.executorModel != nil || bridge.advisorModel != nil {
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Active models")
                        .font(.callout.weight(.semibold))
                    modelsBlock
                }
            }

            // Phase 1d.32 — Personality row. Tiny but useful: the
            // web Settings popover toggles it (Marvin vs neutral)
            // and the user shouldn't have to dig in there to confirm
            // which voice MARVIN is currently using.
            if let personality = bridge.personality {
                Divider()
                aboutRow("personality", personality)
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
        .frame(width: 460, height: 540)
        // Phase 1d.17 — same theme-following as the main window so
        // opening About from a dark-themed session doesn't punch
        // out a light panel. Still falls back to system when the
        // web side hasn't reported a theme yet.
        .preferredColorScheme(bridge.preferredColorScheme)
    }

    @ViewBuilder
    private var modelsBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let executor = bridge.executorModel {
                aboutRow("executor", executor)
            }
            if let advisor = bridge.advisorModel {
                aboutRow("advisor", advisor)
            }
        }
        .font(.body.monospaced())
    }

    @ViewBuilder
    private var projectBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let name = bridge.projectName {
                aboutRow("name", name)
            }
            if let dir = bridge.projectWorkDir {
                aboutRow("workDir", dir)
            }
            if let branch = bridge.branch {
                let suffix = bridge.branchDirtyCount > 0
                    ? " (\(bridge.branchDirtyCount) uncommitted)"
                    : ""
                aboutRow("branch", "\(branch)\(suffix)")
            }
        }
        .font(.body.monospaced())
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
