// ChatMessageModels — domain types for the native message list.
//
// Phase 2c. The shapes here mirror what apps/web/src/components/
// chat/types.ts (`Block`, `Message`) declares on the React side, so
// the two renderers stay easy to keep in sync without forcing a
// codegen step. We deliberately don't share types via a JSON Schema
// or codegen — the types are small (4 block variants, 4 roles) and
// the cost of a schema layer would exceed the cost of keeping them
// aligned by hand.
//
// ## Roles
//
// The Claude CLI stream-json wire shape uses `"role"` as part of an
// inner `message` object on assistant cli.events. We surface the
// role at the top of each `Message` value so the SwiftUI cell can
// branch on `message.role` without reaching into block content. The
// `system` and `result` roles aren't in the wire as such — we map
// the cli.event types `system` (init / rate_limit_event) and
// `result` (terminal payload of one turn) to those roles so the
// list can show them as faint metadata rows distinct from the
// streaming chat itself.
//
// ## Blocks
//
// One assistant `message.content` from the wire is an array of
// blocks: text + tool_use interleaved. A tool_use block names a
// tool (Bash, Edit, Read, etc.) and carries its input; the tool's
// output comes back later as a `user` cli.event whose content is a
// single tool_result block. We keep tool_use and tool_result
// pair-able via the shared `tool_use_id` Claude assigns.

import Foundation

/// Role of one Message. Plain enum — no associated values; per-role
/// data lives in blocks or in the row view's logic.
enum ChatRole: String, Equatable {
    /// What the user typed and submitted.
    case user
    /// Assistant-side message: text + tool calls.
    case assistant
    /// Sidecar / Claude CLI metadata (init, rate limits). Renders
    /// as faint single-line rows.
    case system
    /// Terminal payload of one turn — duration / cost / token usage.
    /// Rendered as a faint footer row when shown at all.
    case result
}

/// Result data attached to a toolCall block once its tool_result
/// arrives on the wire. Phase 2d pairs tool_use + tool_result by
/// tool_use_id so they render as a single collapsible card.
struct ChatToolResult: Equatable {
    let output: String
    let isError: Bool
}

/// One block inside a Message. Discriminated union; SwiftUI cells
/// branch on the case to pick a renderer. Identifiable so List can
/// diff blocks within a message without re-rendering the whole row.
///
/// `toolCall` carries both the call (input) and the eventual result
/// (`result` is `nil` until the matching tool_result arrives). This
/// is the Phase 2d shape — Phase 2c had separate `toolUse` and
/// `toolResult` cases that produced 1-call = 2-rows; pairing here
/// matches the web layout (one card per tool invocation).
///
/// `orphanToolResult` is the rare defensive case: a tool_result
/// arrived but no preceding tool_use with that id was seen (server
/// glitch / out-of-order delivery). Phase 2c rendered every result
/// as its own row; we keep that path as `orphanToolResult` so a
/// dropped tool_use doesn't lose the result content entirely.
enum ChatBlock: Identifiable, Equatable {
    case text(id: String, text: String)
    case toolCall(
        id: String,                // = tool_use_id
        name: String,
        input: ChatJSON?,
        result: ChatToolResult?
    )
    case orphanToolResult(id: String, toolUseId: String, output: String, isError: Bool)
    /// Anything we don't yet recognise in the wire — surfaced as a
    /// monospace dump so we can see what's flowing without forcing
    /// every future block type to ship a renderer first.
    case unknown(id: String, kind: String, raw: String)

    var id: String {
        switch self {
        case .text(let id, _): return "text-\(id)"
        case .toolCall(let id, _, _, _): return "tool-\(id)"
        case .orphanToolResult(let id, _, _, _): return "orphan-\(id)"
        case .unknown(let id, _, _): return "unk-\(id)"
        }
    }
}

/// One message in the native chat list. `id` is stable — we mint it
/// from the Claude message id when present, fall back to a UUID for
/// user-side messages we generate locally before any wire echo.
struct ChatMessage: Identifiable, Equatable {
    let id: String
    let role: ChatRole
    var blocks: [ChatBlock]
    /// True while the assistant is still streaming this message
    /// (no terminal `result` event seen yet for the turn that
    /// produced it). The cell uses this to draw a subtle "live"
    /// pulse — Phase 2c just dims the timestamp; Phase 2d/e will
    /// add a proper streaming indicator.
    var isStreaming: Bool
    /// When the message was first observed on the wire (or sent).
    /// Drives nothing visible in 2c; reserved for the timestamp
    /// gutter we'll add in 2d.
    let createdAt: Date

    /// Convenience initializer for the local user-side echo —
    /// caller doesn't have to assemble the block array.
    static func userText(_ text: String) -> ChatMessage {
        let blockId = UUID().uuidString
        return ChatMessage(
            id: "user-\(UUID().uuidString)",
            role: .user,
            blocks: [.text(id: blockId, text: text)],
            isStreaming: false,
            createdAt: Date()
        )
    }
}

// MARK: - Stream-json reducer

/// Reduces one Claude CLI stream-json event (the inner `data` of an
/// SSE `cli.event`) into a state mutation on the message list.
///
/// We decode the outer envelope here just enough to dispatch by
/// `type`. Inner shapes are decoded inside each case so a new
/// optional field on (say) the result event doesn't trip the
/// dispatcher; tolerant decoding is the goal — we'd rather skip an
/// unknown event than crash on it.
enum ChatStreamReducer {
    /// Apply one cli.event payload to the current list. Returns
    /// the updated array. Call sites use the returned value via
    /// `messages = ChatStreamReducer.apply(messages, cliEventData: data)`
    /// rather than inout to keep the function pure-ish + easy to
    /// reason about in tests later.
    static func apply(_ messages: [ChatMessage], cliEventData data: Data) -> [ChatMessage] {
        // Pull just the discriminator out — every cli.event has a
        // top-level `type`. Failing to parse the discriminator means
        // the payload isn't shaped like a Claude CLI event; skip.
        guard let type = peekType(in: data) else { return messages }

        switch type {
        case "assistant":
            return reduceAssistant(messages, data: data)
        case "user":
            return reduceUser(messages, data: data)
        case "system":
            return reduceSystem(messages, data: data)
        case "result":
            return reduceResult(messages, data: data)
        default:
            // rate_limit_event, partial_assistant_message, etc. —
            // no list-visible mutation today. Phase 2d adds streaming
            // text deltas which will care about partial_assistant_message.
            return messages
        }
    }

    // MARK: Decoders for each cli.event type

    private struct AssistantEnvelope: Codable {
        let message: AssistantMessage
        struct AssistantMessage: Codable {
            let id: String
            let role: String?
            let content: [ContentBlock]
            let stop_reason: String?
        }
    }

    private struct UserEnvelope: Codable {
        let message: UserMessage
        struct UserMessage: Codable {
            let role: String?
            let content: [ContentBlock]
        }
    }

    private struct ResultEnvelope: Codable {
        let subtype: String?
        let is_error: Bool?
        let duration_ms: Int?
        let result: String?
        let session_id: String?
    }

    /// One inner content block. Tagged by `type`; we use ChatJSON
    /// for `input` (tool_use) and accept either string or block-array
    /// for `content` (tool_result).
    private struct ContentBlock: Codable {
        let type: String
        // text block
        let text: String?
        // tool_use block
        let id: String?
        let name: String?
        let input: ChatJSON?
        // tool_result block
        let tool_use_id: String?
        let content: ChatJSON?
        let is_error: Bool?
    }

    private static func peekType(in data: Data) -> String? {
        struct TypePeek: Codable { let type: String }
        return (try? JSONDecoder().decode(TypePeek.self, from: data))?.type
    }

    private static func reduceAssistant(_ messages: [ChatMessage], data: Data) -> [ChatMessage] {
        guard let env = try? JSONDecoder().decode(AssistantEnvelope.self, from: data) else {
            return messages
        }
        let blocks = env.message.content.compactMap { block -> ChatBlock? in
            switch block.type {
            case "text":
                return .text(
                    id: block.id ?? UUID().uuidString,
                    text: block.text ?? ""
                )
            case "tool_use":
                // Phase 2d — toolCall blocks ship with no result;
                // the matching tool_result event lands later and
                // mutates this block in place via reduceUser.
                return .toolCall(
                    id: block.id ?? UUID().uuidString,
                    name: block.name ?? "tool",
                    input: block.input,
                    result: nil
                )
            default:
                return .unknown(
                    id: block.id ?? UUID().uuidString,
                    kind: block.type,
                    raw: String(describing: block)
                )
            }
        }
        // Replace-or-append: each Claude assistant message has a
        // stable id (msg_…). If we already have a row with that id,
        // we PRESERVE existing tool results — the SDK occasionally
        // re-emits an assistant message after its tool_result has
        // landed; without this guard we'd zap the result back to
        // nil and the card would lose the output.
        var out = messages
        if let idx = out.firstIndex(where: { $0.id == env.message.id }) {
            let merged = mergePreservingResults(
                old: out[idx].blocks,
                new: blocks
            )
            out[idx].blocks = merged
            out[idx].isStreaming = (env.message.stop_reason == nil)
        } else {
            out.append(ChatMessage(
                id: env.message.id,
                role: .assistant,
                blocks: blocks,
                isStreaming: env.message.stop_reason == nil,
                createdAt: Date()
            ))
        }
        return out
    }

    /// Merge a fresh assistant block array into an existing one,
    /// preserving any toolCall results we'd already attached. The
    /// new array is authoritative for everything except `result`
    /// on toolCall blocks; that lives in the old array if set.
    private static func mergePreservingResults(
        old: [ChatBlock],
        new: [ChatBlock]
    ) -> [ChatBlock] {
        var resultsById: [String: ChatToolResult] = [:]
        for block in old {
            if case let .toolCall(id, _, _, .some(result)) = block {
                resultsById[id] = result
            }
        }
        return new.map { block in
            if case let .toolCall(id, name, input, _) = block,
               let preserved = resultsById[id] {
                return .toolCall(id: id, name: name, input: input, result: preserved)
            }
            return block
        }
    }

    private static func reduceUser(_ messages: [ChatMessage], data: Data) -> [ChatMessage] {
        // `user` cli.events from the SDK carry tool_result blocks —
        // not the user's typed input. Phase 2d: pair each result
        // back to its toolCall by tool_use_id so the call + result
        // render as one card. Defensive fallback: if no matching
        // toolCall is found, append the result as an orphan row so
        // the output isn't lost.
        guard let env = try? JSONDecoder().decode(UserEnvelope.self, from: data) else {
            return messages
        }
        var out = messages
        var orphans: [ChatBlock] = []

        for block in env.message.content where block.type == "tool_result" {
            let toolUseId = block.tool_use_id ?? ""
            let result = ChatToolResult(
                output: stringify(block.content),
                isError: block.is_error ?? false
            )
            if !attachResult(in: &out, toolUseId: toolUseId, result: result) {
                orphans.append(.orphanToolResult(
                    id: toolUseId.isEmpty ? UUID().uuidString : toolUseId,
                    toolUseId: toolUseId,
                    output: result.output,
                    isError: result.isError
                ))
            }
        }

        if !orphans.isEmpty {
            out.append(ChatMessage(
                id: "orphan-tools-\(UUID().uuidString)",
                role: .system,
                blocks: orphans,
                isStreaming: false,
                createdAt: Date()
            ))
        }
        return out
    }

    /// Find the toolCall with a matching `toolUseId` (scanning
    /// newest-first, since results come right after their calls)
    /// and attach its result. Returns true on success.
    private static func attachResult(
        in messages: inout [ChatMessage],
        toolUseId: String,
        result: ChatToolResult
    ) -> Bool {
        guard !toolUseId.isEmpty else { return false }
        for mIdx in messages.indices.reversed() {
            for bIdx in messages[mIdx].blocks.indices {
                if case let .toolCall(id, name, input, _) = messages[mIdx].blocks[bIdx],
                   id == toolUseId {
                    messages[mIdx].blocks[bIdx] = .toolCall(
                        id: id,
                        name: name,
                        input: input,
                        result: result
                    )
                    return true
                }
            }
        }
        return false
    }

    private static func reduceSystem(_ messages: [ChatMessage], data: Data) -> [ChatMessage] {
        // We only surface a system row for the very first `system`
        // event of a turn (subtype: init), and even then keep it
        // terse — the React side does the same. Skip rate_limit_event
        // and other noise.
        struct SystemEnvelope: Codable {
            let subtype: String?
        }
        guard let env = try? JSONDecoder().decode(SystemEnvelope.self, from: data) else {
            return messages
        }
        guard env.subtype == "init" else { return messages }
        var out = messages
        out.append(ChatMessage(
            id: "system-\(UUID().uuidString)",
            role: .system,
            blocks: [.text(id: UUID().uuidString, text: "session initialised")],
            isStreaming: false,
            createdAt: Date()
        ))
        return out
    }

    private static func reduceResult(_ messages: [ChatMessage], data: Data) -> [ChatMessage] {
        guard let env = try? JSONDecoder().decode(ResultEnvelope.self, from: data) else {
            return messages
        }
        // Mark any still-streaming assistant message as completed.
        var out = messages
        for i in out.indices where out[i].isStreaming {
            out[i].isStreaming = false
        }
        // Append a quiet result row showing duration + outcome.
        let success = env.is_error == false
        let text: String
        if success, let ms = env.duration_ms {
            text = "completed in \(ms)ms"
        } else if let r = env.result {
            text = "ended: \(r)"
        } else {
            text = "ended"
        }
        out.append(ChatMessage(
            id: "result-\(UUID().uuidString)",
            role: .result,
            blocks: [.text(id: UUID().uuidString, text: text)],
            isStreaming: false,
            createdAt: Date()
        ))
        return out
    }

    /// Tool result `content` is either a string or an array of
    /// {type:"text", text:"..."} blocks. Flatten either to a plain
    /// string for the cell renderer.
    private static func stringify(_ value: ChatJSON?) -> String {
        guard let value else { return "" }
        switch value {
        case .string(let s):
            return s
        case .array(let items):
            return items.compactMap { item -> String? in
                if case let .object(dict) = item, case let .string(s) = dict["text"] ?? .null {
                    return s
                }
                return nil
            }.joined(separator: "\n")
        default:
            return String(describing: value)
        }
    }
}
