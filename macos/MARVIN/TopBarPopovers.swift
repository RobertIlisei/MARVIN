// TopBarPopovers — Phase 5d. Native peers of the web app's
// LayoutPopover + SetupPopover (apps/web/src/components/shell/
// top-bar-popovers.tsx). Mounted as NSToolbar items in MARVINApp.
//
// Why native peers instead of letting the web popovers stand:
//
//   • The web top bar reads as a duplicate stripe inside the SwiftUI
//     shell — there's already a native NSToolbar above it. Hiding the
//     web stripe lost the popovers (the user complained); building
//     native peers gets us back to a single chrome layer.
//   • IDE feel — VS Code, Xcode, IntelliJ all surface settings +
//     panes from the title bar / toolbar, not from a content-area
//     stripe.
//   • The setters cross the bridge cleanly: each control fires a
//     marvin:set-* CustomEvent which the prefs context handles.
//     localStorage stays the source of truth.
//
// Wire shape (each setter):
//   marvin:set-personality         { value: "marvin" | "neutral" }
//   marvin:set-permission-strategy { value: "auto" | "gated" }
//   marvin:set-models              { executor: string|null, advisor: string|null }
//   marvin:toggle-pane             { key: "files"|"graph"|"brain"|"preview"|"terminal" }

import SwiftUI
import AppKit

// MARK: - Layout popover

/// Toolbar popover surface for pane visibility — files / graph /
/// brain / preview / terminal. Mirrors the web LayoutPopover row
/// for row.
struct LayoutPopoverContent: View {
    @Environment(MarvinBridge.self) private var bridge

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PANES")
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 12)
                .padding(.top, 12)
                .padding(.bottom, 6)
            paneRow(
                key: "files",
                label: "files",
                kbd: "⌘B",
                tip: "project file tree",
                active: bridge.panes.files,
                disabled: false
            )
            paneRow(
                key: "graph",
                label: "graph",
                kbd: "⌘G",
                tip: "knowledge graph of the codebase",
                active: bridge.panes.graph,
                disabled: bridge.projectWorkDir == nil
            )
            paneRow(
                key: "brain",
                label: "brain",
                kbd: nil,
                tip: "live MARVIN brain visualization",
                active: bridge.panes.brain,
                disabled: false
            )
            paneRow(
                key: "preview",
                label: "preview",
                kbd: "⌘⇧P",
                tip: "live web preview of dev server",
                active: bridge.panes.preview,
                disabled: bridge.projectWorkDir == nil
            )
            paneRow(
                key: "terminal",
                label: "terminal",
                kbd: "⌘J",
                tip: "embedded terminal in the project cwd",
                active: bridge.panes.terminal,
                disabled: bridge.projectWorkDir == nil
            )
        }
        .frame(width: 280)
        .padding(.bottom, 8)
    }

    private func paneRow(
        key: String,
        label: String,
        kbd: String?,
        tip: String,
        active: Bool,
        disabled: Bool
    ) -> some View {
        Button {
            NativePrefs.shared.togglePane(key)
        } label: {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(label)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(.primary)
                    Text(tip)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let kbd {
                    Text(kbd)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                // On/off pip mirrors the web PaneToggle.
                Text(active ? "on" : "off")
                    .font(.system(size: 10, design: .monospaced))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(active
                                  ? Color.accentColor.opacity(0.18)
                                  : Color.gray.opacity(0.12))
                    )
                    .foregroundStyle(active ? Color.accentColor : .secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .opacity(disabled ? 0.4 : 1)
    }
}

// MARK: - Setup popover

/// Toolbar popover surface for permissions / models / personality.
/// Mirrors the web SetupPopover. Models opens a dedicated sheet via
/// `onOpenModelsDialog` instead of stuffing the picker in here —
/// the picker is too tall (preset cards + two selects).
struct SetupPopoverContent: View {
    @Environment(MarvinBridge.self) private var bridge
    @Binding var modelsDialogOpen: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Permissions
            HStack(spacing: 8) {
                Text("PERMS")
                    .font(.system(size: 10, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 8)
                segmented(
                    options: [("auto", "auto"), ("gated", "gated")],
                    active: bridge.permissionStrategy,
                    onSelect: { value in
                        NativePrefs.shared.setPermissionStrategy(value)
                    }
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            // Models — one-line summary + button to open the dialog.
            VStack(alignment: .leading, spacing: 6) {
                Text("MODELS")
                    .font(.system(size: 10, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(.tertiary)
                Button {
                    modelsDialogOpen = true
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(modelSummary)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text("executor / advisor — click to configure")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color(nsColor: .underPageBackgroundColor))
                            .overlay(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                            )
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            // Voice (= personality)
            HStack(spacing: 8) {
                Text("VOICE")
                    .font(.system(size: 10, design: .monospaced))
                    .tracking(2)
                    .foregroundStyle(.tertiary)
                Spacer(minLength: 8)
                segmented(
                    options: [("marvin", "marvin"), ("neutral", "neutral")],
                    active: bridge.personality ?? "marvin",
                    onSelect: { value in
                        NativePrefs.shared.setPersonality(value)
                    }
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .frame(width: 340)
        .padding(.vertical, 4)
    }

    /// Lossy short summary mirroring web's `summariseModels`.
    private var modelSummary: String {
        let trim: (String) -> String = { id in
            var s = id
            if s.hasPrefix("claude-") { s = String(s.dropFirst("claude-".count)) }
            // Strip trailing -2YYMMDD date suffix.
            if let r = s.range(of: #"-2\d{6}$"#, options: .regularExpression) {
                s = String(s[..<r.lowerBound])
            }
            return s
        }
        let executor = bridge.executorModel
        let advisor = bridge.advisorModel
        switch (executor, advisor) {
        case (nil, nil):
            return "default · runtime decides"
        case (let e?, nil):
            return trim(e)
        case (let e?, let a?):
            return "\(trim(e)) → \(trim(a))"
        case (nil, let a?):
            return "default → \(trim(a))"
        }
    }

    /// Tiny segmented control. SwiftUI's `Picker(.segmented)` would
    /// work but its default appearance reads heavy inside a popover;
    /// a custom row keeps the tint consistent with the web toggles.
    private func segmented(
        options: [(value: String, label: String)],
        active: String,
        onSelect: @escaping (String) -> Void
    ) -> some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.value) { opt in
                let isActive = opt.value == active
                Button {
                    if !isActive { onSelect(opt.value) }
                } label: {
                    Text(opt.label)
                        .font(.system(size: 11, design: .monospaced))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .foregroundStyle(isActive ? Color.accentColor : .secondary)
                        .frame(minWidth: 56)
                }
                .buttonStyle(.plain)
                .background(
                    Rectangle()
                        .fill(isActive
                              ? Color.accentColor.opacity(0.18)
                              : Color.clear)
                )
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color(nsColor: .underPageBackgroundColor))
                .overlay(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
                )
        )
        .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

// MARK: - Models dialog

/// Sheet-presented model picker. Fetches /api/models, lets the user
/// pick an executor and advisor, dispatches `set-models` on apply.
/// Mirrors the web ModelsDialog at a smaller surface — preset cards
/// are deferred (they're ergonomic sugar; the two pickers cover the
/// functional case fully).
struct ModelsDialog: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.dismiss) private var dismiss

    @State private var executor: String? = nil
    @State private var advisor: String? = nil
    @State private var available: [ModelInfoLite] = []
    @State private var source: String = "loading"
    @State private var loadError: String? = nil
    @State private var isLoading: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Models")
                    .font(.title2.weight(.semibold))
                Spacer()
                if source == "fallback" {
                    Text("fallback list")
                        .font(.caption2.monospaced())
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.18))
                        .foregroundStyle(.secondary)
                        .clipShape(Capsule())
                        .help("Couldn't reach Anthropic — using a hardcoded list. May be stale.")
                }
            }
            Text("Pick the model that runs the main turn (executor) and the optional second-opinion model (advisor). Both nullable — null means \"runtime decides\".")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 30)
            } else if let err = loadError {
                Text("Failed to load: \(err)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
            } else {
                pickerRow(
                    label: "Executor",
                    binding: $executor,
                    description: "primary turn — what handles `assistant` messages"
                )
                pickerRow(
                    label: "Advisor",
                    binding: $advisor,
                    description: "second-opinion when MARVIN runs an advisor consult"
                )
            }

            HStack {
                Button("Reset to default") {
                    executor = nil
                    advisor = nil
                }
                .buttonStyle(.borderless)
                .disabled(executor == nil && advisor == nil)
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Apply") {
                    NativePrefs.shared.setModels(executor: executor, advisor: advisor)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(executor == bridge.executorModel
                          && advisor == bridge.advisorModel)
            }
        }
        .padding(24)
        .frame(width: 540)
        .onAppear {
            executor = bridge.executorModel
            advisor = bridge.advisorModel
            Task { await loadModels() }
        }
    }

    private func pickerRow(
        label: String,
        binding: Binding<String?>,
        description: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label)
                    .font(.callout.weight(.semibold))
                Text(description)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            Picker("", selection: binding) {
                Text("default · runtime decides").tag(String?.none)
                ForEach(["opus", "sonnet", "haiku", "other"], id: \.self) { tier in
                    let group = available.filter { $0.tier == tier }
                    if !group.isEmpty {
                        // Tier header — section text via a divider-ish entry.
                        Section(header: Text(tier.uppercased())) {
                            ForEach(group, id: \.id) { m in
                                Text(m.displayName)
                                    .tag(Optional(m.id))
                            }
                        }
                    }
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
        }
    }

    /// Fetch /api/models and parse into a small in-process model list.
    private func loadModels() async {
        defer { isLoading = false }
        let url = ServerConfig.baseURL.appendingPathComponent("api/models")
        var req = URLRequest(url: url)
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            struct Wire: Codable {
                struct Model: Codable {
                    let id: String
                    let displayName: String
                    let tier: String
                }
                let models: [Model]
                let source: String
            }
            let parsed = try JSONDecoder().decode(Wire.self, from: data)
            available = parsed.models.map {
                ModelInfoLite(id: $0.id, displayName: $0.displayName, tier: $0.tier)
            }
            source = parsed.source
        } catch {
            loadError = "\(error)"
        }
    }

    /// Tiny mirror of /api/models's ModelInfo. Lives here because no
    /// other Swift file consumes this shape today.
    struct ModelInfoLite: Identifiable, Equatable {
        let id: String
        let displayName: String
        let tier: String
    }
}
