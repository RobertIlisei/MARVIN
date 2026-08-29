// UpdatePromptView — the "a newer MARVIN is out" sheet (ADR-0086).
//
// Deliberately not an auto-updater. MARVIN holds live agent turns and
// background jobs; replacing the bundle underneath one kills work that
// reports nothing back (ADR-0038). So this hands over the command and gets
// out of the way. Three exits: upgrade instructions, skip this version, or
// later — and "skip" is per-version, never permanent.

import AppKit
import MARVINLogic
import SwiftUI

struct UpdatePromptView: View {
    let decision: UpdateDecision
    let onSkip: () -> Void
    let onLater: () -> Void
    let onRelease: () -> Void

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "arrow.down.circle.fill")
                    .font(.system(size: 22))
                    .foregroundStyle(.blue)
                VStack(alignment: .leading, spacing: 2) {
                    Text("MARVIN \(decision.latest) is available")
                        .font(.headline)
                    Text("You're on \(decision.current).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Upgrade with Homebrew")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    Text(UpdateService.upgradeCommand)
                        .font(.system(size: 12, design: .monospaced))
                        .textSelection(.enabled)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(MarvinTheme.elevated, in: RoundedRectangle(cornerRadius: 5))
                    Button(copied ? "Copied" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(UpdateService.upgradeCommand, forType: .string)
                        copied = true
                    }
                    .buttonStyle(.borderless)
                }
                Text("MARVIN doesn't update itself — a swap mid-turn would kill work in flight. Quit it first, then run the command.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Button("Release notes") { onRelease() }
                    .buttonStyle(.borderless)
                Spacer()
                Button("Skip \(decision.latest)") { onSkip() }
                Button("Later") { onLater() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 420)
    }
}
