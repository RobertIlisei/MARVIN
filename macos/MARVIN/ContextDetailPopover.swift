// ContextDetailPopover — the status-bar "ctx" chip's click target. A
// /context-style breakdown of the context window.
//
// Headline (EXACT): resident tokens / model window, as a % with a colour bar.
// `resident` is the live SDK figure (cache_read + input) already on the bridge.
//
// Breakdown (ESTIMATED): the fixed prompt prefix from GET /api/context —
// system prompt, tools+MCP, project-context sections — plus a derived
// transcript row (resident − prefix) and the free remainder. Category rows are
// ~length/4 estimates and are labeled as such; only the headline is exact.

import SwiftUI
import MARVINLogic

struct ContextDetailPopover: View {
    let resident: Int
    let billable: Int?
    let workDir: String?
    let model: String?
    let personality: String?
    let graphCalls: Int
    let fileReadCalls: Int

    @State private var estimate: ContextEstimate? = nil
    @State private var loadFailed = false

    private var window: Int {
        // Prefer the server's window (authoritative) once loaded; fall back to
        // the client-side model lookup so the headline is right immediately.
        estimate?.contextWindow ?? ContextUsageReader.contextWindow(forModelId: model)
    }
    private var band: ContextBand {
        ContextUsageReader.band(forTokens: resident, window: window)
    }
    private var fraction: Double {
        window > 0 ? min(1.0, Double(resident) / Double(window)) : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("context window")
                .font(.caption.monospaced())
                .tracking(2)
                .textCase(.uppercase)
                .foregroundStyle(.tertiary)

            headline

            if let est = estimate {
                breakdown(est)
            } else if loadFailed {
                Text("couldn't load the category breakdown — the headline above is still exact.")
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("estimating categories…")
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                }
            }

            Divider()

            HStack {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 10))
                Text("graph \(graphCalls) · reads \(fileReadCalls)")
                Spacer()
            }
            .font(.callout.monospaced())
            .foregroundStyle(.secondary)

            Button {
                NotificationCenter.default.post(name: .marvinRequestSdkReset, object: nil)
            } label: {
                Label("Reset context for next message", systemImage: "arrow.counterclockwise")
                    .font(.callout.monospaced())
            }
            .buttonStyle(.borderless)
            .help("Drops the SDK cache that's making decisions slow. The visible chat stays intact; only the next turn starts fresh.")
        }
        .padding(16)
        .frame(width: 340)
        .task { await load() }
    }

    // MARK: - Headline

    private var headline: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(fmtK(resident)) / \(fmtK(window))")
                    .font(.callout.monospaced())
                    .foregroundStyle(.primary)
                Spacer()
                Text("\(Int((fraction * 100).rounded()))%")
                    .font(.callout.monospaced())
                    .foregroundStyle(colour(band))
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(Color.secondary.opacity(0.18))
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(colour(band))
                        .frame(width: max(2, geo.size.width * fraction))
                }
            }
            .frame(height: 6)
            Text(band.hint)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Breakdown

    @ViewBuilder
    private func breakdown(_ est: ContextEstimate) -> some View {
        let prefix = est.estimate.systemPrompt + est.estimate.tools + est.estimate.projectContext.total
        let transcript = max(0, resident - prefix)
        let free = max(0, window - resident)
        VStack(spacing: 4) {
            row("system prompt", est.estimate.systemPrompt, estimated: true)
            row("tools + MCP", est.estimate.tools, estimated: true)
            row("project context", est.estimate.projectContext.total, estimated: true)
            ForEach(est.estimate.projectContext.sections) { s in
                row(s.label, s.approxTokens, estimated: true, indent: true)
            }
            row("transcript", transcript, estimated: true)
            Divider().padding(.vertical, 2)
            row("free", free, estimated: false)
        }
        .font(.callout.monospaced())

        Text("category rows are estimates (~chars÷4) and may not sum to the exact total above")
            .font(.caption2.monospaced())
            .foregroundStyle(.tertiary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func row(_ label: String, _ tokens: Int, estimated: Bool, indent: Bool = false) -> some View {
        HStack(spacing: 6) {
            if indent { Text("·").foregroundStyle(.tertiary) }
            Text(label)
                .foregroundStyle(indent ? .tertiary : .secondary)
            Spacer()
            Text(fmtK(tokens))
                .foregroundStyle(indent ? .secondary : .primary)
        }
        .padding(.leading, indent ? 8 : 0)
    }

    // MARK: - Helpers

    private func load() async {
        guard let workDir, !workDir.isEmpty else { loadFailed = true; return }
        do {
            estimate = try await ContextService.shared.fetch(
                workDir: workDir, model: model, personality: personality
            )
        } catch {
            loadFailed = true
        }
    }

    private func colour(_ band: ContextBand) -> Color {
        switch band {
        case .healthy:  return .secondary
        case .climbing: return .blue
        case .high:     return .orange
        case .critical: return .red
        }
    }

    /// Compact "142K" / "1.0M" token label.
    private func fmtK(_ n: Int) -> String {
        if n >= 1_000_000 {
            return String(format: "%.1fM", Double(n) / 1_000_000)
        }
        if n >= 1_000 {
            return "\(Int((Double(n) / 1000).rounded()))K"
        }
        return "\(n)"
    }
}
