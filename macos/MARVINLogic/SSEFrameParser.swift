// SSEFrameParser — the wire-format half of Server-Sent Events, as a pure
// value type.
//
// MARVIN has two SSE consumers: the chat stream (`ChatService`) and the
// terminal stream (`TerminalRunner`). They were written independently, and
// only one of them was correct.
//
// `TerminalRunner` framed events with `for try await line in bytes.lines` and
// dispatched on `line.isEmpty`. Foundation's `AsyncLineSequence` **never
// yields an empty string** — it treats the `\n\n` that terminates an SSE event
// as one separator, not as a line of length zero. So the dispatch never fired.
// Every event of a `pwd` run accumulated into one buffer, `JSONSerialization`
// rejected the result, and the parse failure was swallowed: the terminal
// echoed the command and printed nothing at all, not even its exit line.
//
// `ChatService` already hand-rolled a byte-level parser to dodge a *different*
// `AsyncBytes.lines` defect (its comment records the smoke turn that stopped
// after three lines). That fix was never carried across. This type is that
// parser, extracted — so there is one implementation, and it is the tested one.
//
// Pure by construction (ADR-0022): bytes in, frames out, no URLSession. That
// is what makes the empty-line rule — the exact thing both bugs turned on —
// something a test can pin.

import Foundation

/// One complete SSE event: the `event:` name (absent for a bare `data:` frame)
/// and the accumulated `data:` payload.
public struct SSEFrame: Equatable {
    public let name: String?
    public let data: String

    public init(name: String?, data: String) {
        self.name = name
        self.data = data
    }
}

/// Incremental SSE parser. Feed it bytes as they arrive; it hands back a frame
/// each time one completes.
public struct SSEFrameParser {
    private var lineBuffer: [UInt8] = []
    private var currentName: String?
    private var currentData: String = ""

    public init() {}

    /// Feed one byte. Returns a frame iff this byte completed the blank line
    /// that terminates an event.
    public mutating func consume(_ byte: UInt8) -> SSEFrame? {
        // '\r' is dropped rather than buffered so CRLF and LF framing behave
        // identically — a server that switches transports must not change how
        // this parses.
        if byte == 0x0D { return nil }
        guard byte == 0x0A else {
            lineBuffer.append(byte)
            return nil
        }
        let line = String(decoding: lineBuffer, as: UTF8.self)
        lineBuffer.removeAll(keepingCapacity: true)
        return accept(line: line)
    }

    /// Feed a chunk of bytes, in order. Returns every frame they completed.
    public mutating func consume(contentsOf bytes: some Sequence<UInt8>) -> [SSEFrame] {
        var out: [SSEFrame] = []
        for byte in bytes {
            if let frame = consume(byte) { out.append(frame) }
        }
        return out
    }

    /// The connection closed. Flushes a trailing line with no newline and any
    /// event that never got its terminating blank line.
    ///
    /// A well-behaved server always sends the blank line, so this is normally
    /// empty — but a truncated response should surface what did arrive rather
    /// than silently discard it.
    public mutating func finish() -> SSEFrame? {
        if !lineBuffer.isEmpty {
            let line = String(decoding: lineBuffer, as: UTF8.self)
            lineBuffer.removeAll(keepingCapacity: true)
            if let frame = accept(line: line) { return frame }
        }
        guard currentName != nil || !currentData.isEmpty else { return nil }
        return flush()
    }

    /// Apply one complete line. THE load-bearing rule is the first branch: an
    /// empty line ends the event. Both historic bugs were failures to ever see
    /// one.
    private mutating func accept(line: String) -> SSEFrame? {
        if line.isEmpty {
            guard currentName != nil || !currentData.isEmpty else { return nil }
            return flush()
        }
        // `:` opens a comment (heartbeats use it). `id:` and `retry:` are
        // spec fields MARVIN has no use for; both fall through unmatched.
        if line.hasPrefix(":") { return nil }
        if let value = field("event:", in: line) {
            currentName = value
        } else if let value = field("data:", in: line) {
            // The spec allows repeated `data:` lines in one event, joined with
            // newlines. Neither of MARVIN's producers emits that today; being
            // tolerant costs one branch.
            currentData += currentData.isEmpty ? value : "\n" + value
        }
        return nil
    }

    private mutating func flush() -> SSEFrame {
        let frame = SSEFrame(name: currentName, data: currentData)
        currentName = nil
        currentData = ""
        return frame
    }

    /// Match `prefix` and strip it plus ONE optional leading space — the space
    /// after the colon is part of the framing, not of the value, so `data:  x`
    /// carries the value `" x"`.
    private func field(_ prefix: String, in line: String) -> String? {
        guard line.hasPrefix(prefix) else { return nil }
        var value = line.dropFirst(prefix.count)
        if value.first == " " { value = value.dropFirst() }
        return String(value)
    }
}
