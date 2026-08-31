// LSPMessageFraming — the LSP wire codec.
//
// LSP is JSON-RPC 2.0 over a stream, framed the way HTTP frames a body:
//
//     Content-Length: 148\r\n
//     \r\n
//     {"jsonrpc":"2.0","id":1,"method":"initialize",...}
//
// Two properties make this worth isolating and testing rather than
// inlining into the client:
//
//   1. **A framing bug is silent and permanent.** Parse a header one byte
//      off and the stream desynchronises forever — every subsequent
//      message is garbage, and nothing errors. The symptom is "the
//      language server does nothing", which is indistinguishable from
//      "the server isn't installed".
//   2. **Reads do not align with messages.** A pipe hands you whatever
//      happened to arrive: half a header, three messages at once, a body
//      split mid-UTF-8. The decoder must be a buffer that yields zero or
//      more complete messages per feed, never assume one read is one
//      message.
//
// Pure (ADR-0022) so both are pinned by tests with no subprocess involved.
//
// `Content-Length` counts BYTES, not characters — a diagnostic message
// containing an em-dash is longer in bytes than in Characters, and slicing
// by the wrong unit truncates the JSON.

import Foundation

public enum LSPMessageFraming {
    public static let headerTerminator = Data("\r\n\r\n".utf8)

    /// Frame one JSON payload for the wire.
    public static func encode(_ payload: Data) -> Data {
        var out = Data("Content-Length: \(payload.count)\r\n\r\n".utf8)
        out.append(payload)
        return out
    }

    /// Incremental decoder. Feed it whatever the pipe produced; take out
    /// however many whole messages that completed.
    public struct Decoder {
        private var buffer = Data()

        public init() {}

        /// Bytes held pending a complete message. Exposed for tests and for
        /// a "the server is streaming garbage" guard.
        public var pending: Int { buffer.count }

        public mutating func feed(_ chunk: Data) -> [Data] {
            buffer.append(chunk)
            var out: [Data] = []
            while let message = takeOne() { out.append(message) }
            return out
        }

        private mutating func takeOne() -> Data? {
            // A loop, not a single pass, because "I skipped a bad header"
            // and "there is nothing here yet" are different answers and the
            // caller's `while let` cannot tell them apart. Returning nil on
            // a skip stopped the drain, so the VALID message sitting right
            // behind the garbage was withheld until the next read — caught
            // by the recovery test before any server ran.
            while true {
                guard let headerEnd = buffer.range(of: headerTerminator) else {
                    return nil      // header not complete yet
                }
                let headerData = buffer[buffer.startIndex..<headerEnd.lowerBound]
                guard let length = contentLength(in: headerData) else {
                    // A header we cannot read means the stream is already
                    // desynchronised. Drop through it and keep scanning
                    // rather than spinning on the same bytes forever — a
                    // wedged decoder is worse than a lost message.
                    buffer.removeSubrange(buffer.startIndex..<headerEnd.upperBound)
                    continue
                }
                return takeBody(after: headerEnd, length: length)
            }
        }

        private mutating func takeBody(
            after headerEnd: Range<Data.Index>, length: Int
        ) -> Data? {
            let bodyStart = headerEnd.upperBound
            guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= length else {
                return nil          // body still arriving
            }
            let bodyEnd = buffer.index(bodyStart, offsetBy: length)
            let body = Data(buffer[bodyStart..<bodyEnd])
            buffer.removeSubrange(buffer.startIndex..<bodyEnd)
            return body
        }

        /// Case-insensitive header scan. Servers are not consistent about
        /// `Content-Length` vs `content-length`, and some send
        /// `Content-Type` first.
        private func contentLength<C: Collection>(in header: C) -> Int?
        where C.Element == UInt8 {
            guard let text = String(bytes: header, encoding: .utf8) else { return nil }
            for line in text.components(separatedBy: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1)
                guard parts.count == 2 else { continue }
                guard parts[0].trimmingCharacters(in: .whitespaces).lowercased()
                        == "content-length" else { continue }
                return Int(parts[1].trimmingCharacters(in: .whitespaces))
            }
            return nil
        }
    }
}

// MARK: - Position conversion

/// LSP positions are **zero-based** `(line, character)`; every human-facing
/// surface in MARVIN — the Problems panel, `file:line:col` citations, the
/// status bar — is **one-based**. Converting in one named place is the
/// difference between "off by one" being a bug and being impossible.
public enum LSPPosition {
    public static func toDisplayLine(_ zeroBased: Int) -> Int { zeroBased + 1 }
    public static func toDisplayColumn(_ zeroBased: Int) -> Int { zeroBased + 1 }
    public static func fromDisplayLine(_ oneBased: Int) -> Int { max(0, oneBased - 1) }
}

/// Severity as LSP numbers them. Anything outside 1...4 is treated as an
/// error: a server sending a value we don't know is more likely reporting
/// something serious than something ignorable.
public enum LSPSeverity {
    public static func name(_ raw: Int?) -> String {
        switch raw {
        case 1: return "error"
        case 2: return "warning"
        case 3: return "info"
        case 4: return "hint"
        default: return "error"
        }
    }
}
