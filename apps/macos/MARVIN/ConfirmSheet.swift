// ConfirmSheet — Phase 2e modal for `confirm.request` events.
//
// When `permissionStrategy: "gated"` is active, the sidecar pauses
// dangerous tool calls and emits a `confirm.request` event. The user
// has to allow or deny before the agent can proceed. Phase 2c
// surfaced these as inline system rows; Phase 2e presents them as
// proper modal sheets so the user can't accidentally miss one.
//
// ## Layout
//
//   ┌────────────────────────────────────┐
//   │ ⚠ MARVIN wants to run a tool       │
//   │                                    │
//   │ Bash · Run npm test                │
//   │ Reason: not on the auto-allow list │
//   │                                    │
//   │ ┌──────────────────────────────┐   │
//   │ │ $ npm test                   │   │
//   │ └──────────────────────────────┘   │
//   │                                    │
//   │ ┌────────── deny message ──────┐   │
//   │ │ Optional reason for denying  │   │
//   │ └──────────────────────────────┘   │
//   │                                    │
//   │            [Deny] [Allow]          │
//   └────────────────────────────────────┘
//
// ## What "Allow Always" doesn't get
//
// ADR-0017's sub-phase table mentions "Allow / Allow always / Deny"
// but the API only supports allow / deny — "allow always" is web-
// side state that auto-allows future calls of the same tool. We
// omit it in the native sheet for now; the web confirm UX is still
// available if the user needs auto-allow behaviour. If we add it,
// it'll need a Settings-side store (`marvin.allowAlways = ["Bash",…]`)
// the bridge consults.

import SwiftUI

struct ConfirmSheet: View {
    let request: ConfirmRequest
    let onAllow: () -> Void
    let onDeny: (String?) -> Void

    @State private var denyMessage: String = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            Divider()
            toolBlock
            if let reason = request.reason, !reason.isEmpty {
                reasonBlock(reason)
            }
            Divider()
            denyMessageField
            Spacer(minLength: 0)
            actions
        }
        .padding(20)
        .frame(width: 520)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.shield.fill")
                .font(.title2)
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("MARVIN wants to use a tool")
                    .font(.headline)
                Text(request.title ?? request.displayName ?? request.toolName)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    /// Reuse the per-tool input renderer from the message list so
    /// the user sees Bash commands as `$ ...`, file edits with the
    /// path, etc. — exactly the same way they'd see it in the chat
    /// list once the call goes through.
    private var toolBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(request.toolName)
                    .font(.caption.monospaced().weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .fill(Color.orange.opacity(0.18))
                    )
                if let desc = request.description, !desc.isEmpty {
                    Text(desc)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
            }
            if let input = request.input {
                ConfirmToolInput(name: request.toolName, input: input)
            }
        }
    }

    private func reasonBlock(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("Reason:")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var denyMessageField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Deny message (optional)")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField(
                "Why are you denying? Shown back to the model.",
                text: $denyMessage,
                axis: .vertical
            )
            .lineLimit(2...4)
            .textFieldStyle(.roundedBorder)
        }
    }

    private var actions: some View {
        HStack {
            Spacer()
            Button("Deny") {
                onDeny(denyMessage.isEmpty ? nil : denyMessage)
                dismiss()
            }
            .keyboardShortcut(.cancelAction)
            Button("Allow") {
                onAllow()
                dismiss()
            }
            .keyboardShortcut(.defaultAction)
            .buttonStyle(.borderedProminent)
        }
    }
}

/// Tool input renderer for the confirm sheet. Same shapes as the
/// in-line ToolInputView in ChatMessageRow — duplicated here as a
/// small private struct so the two surfaces can diverge if the
/// confirm sheet's needs (e.g. editable Bash command, diff preview
/// for Edit) outgrow the chat list's needs without breaking either.
/// Phase 2e keeps it terse; future phases polish.
private struct ConfirmToolInput: View {
    let name: String
    let input: ChatJSON

    var body: some View {
        switch name {
        case "Bash":
            bashView
        case "Edit", "Write":
            fileMutationView
        default:
            jsonDumpView
        }
    }

    private var bashView: some View {
        let cmd = stringField("command") ?? prettyJSON(input)
        return ScrollView {
            HStack(alignment: .top, spacing: 6) {
                Text("$")
                    .font(.body.monospaced().weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(cmd)
                    .font(.body.monospaced())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .padding(10)
        }
        .frame(maxHeight: 120)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.5))
        )
    }

    private var fileMutationView: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let path = stringField("file_path") ?? stringField("path") {
                Label(path, systemImage: "doc.text")
                    .font(.callout.monospaced())
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
            }
            if name == "Edit" {
                let oldLen = stringField("old_string")?.count ?? 0
                let newLen = stringField("new_string")?.count ?? 0
                Text("Replace \(oldLen) chars with \(newLen) chars")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            } else if name == "Write", let content = stringField("content") {
                Text("Write \(content.count) chars")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.5))
        )
    }

    private var jsonDumpView: some View {
        ScrollView {
            Text(prettyJSON(input))
                .font(.caption.monospaced())
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxHeight: 120)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(Color(nsColor: .textBackgroundColor).opacity(0.5))
        )
    }

    private func stringField(_ key: String) -> String? {
        guard case let .object(dict) = input,
              case let .string(s) = dict[key] ?? .null else {
            return nil
        }
        return s
    }
}

/// Local pretty-printer mirror — duplicated from ChatMessageRow's
/// private helper because both surfaces need the same output and
/// neither one wants a public dependency on the other.
private func prettyJSON(_ value: ChatJSON) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value),
          let text = String(data: data, encoding: .utf8) else {
        return "\(value)"
    }
    return text
}
