// ToolUseCounter — pure helper for the AppStatusBar "graph vs files"
// chip. Parses `cli.event` payloads (the SDK's raw assistant events)
// and returns counts for the per-session ratio.
//
// Why this exists (2026-05-27 audit):
//
//   Across 7 days of project sessions, MARVIN called `graph_search` 406×
//   while calling `graph_summary` 2×, `graph_query` 8×, and
//   `graph_save_result` 0× — meanwhile `Read`/`Grep`/`Glob` fired ~900×
//   per session. The protocol said "graphify-first"; the data said
//   "search once, then 900 file ops". This chip surfaces the drift live
//   so the user can see when MARVIN bypasses the graph.
//
// Two responsibilities, both pure functions for unit-test pinning:
//
//   1. `Counts.merge(cliEventData:)` — given a `cli.event` payload,
//      increment graph_*, file-read, and graph_summary counters in
//      place. Caller owns the running totals.
//   2. `band(graph:fileReads:)` — classify a (graph_calls, file_reads)
//      pair into one of four health bands. Tuned to the 7:1 drift the
//      audit found.
//
// We do not attempt to detect intent ("should this Read have been a
// graph_query?"). The chip is a signal, not a verdict. The user
// reads the colour to decide whether to nudge MARVIN.

import Foundation

/// Health band for the (graph_calls, file_reads) ratio. Stable enum
/// values so AppStatusBar can switch on the case without re-reading
/// the thresholds.
public enum ToolUseBand: Sendable {
    /// Not enough signal yet (low absolute counts).
    case idle
    /// Healthy ratio — graph calls are pulling their weight.
    case healthy
    /// Drifting — file reads pulling ahead of graph calls.
    case drifting
    /// Egregious drift — file reads far outpace graph calls,
    /// or no `graph_summary` after many reads.
    case critical

    public var hint: String {
        switch self {
        case .idle:     return "Tool use — warming up"
        case .healthy:  return "Graph + files in balance"
        case .drifting: return "Drifting — many reads, few graph calls"
        case .critical: return "Graphify protocol drift — protocol says graph-first"
        }
    }
}

public struct ToolUseCounts: Sendable, Equatable {
    /// All `mcp__marvin-graph__*` tool_use blocks seen this session.
    public var graphCalls: Int = 0
    /// `Read` + `Grep` + `Glob` tool_use blocks seen this session.
    public var fileReadCalls: Int = 0
    /// `graph_summary` calls specifically. Used by the band check —
    /// the protocol requires `graph_summary` at the start of any
    /// non-trivial conversation; if it's 0 after many file reads
    /// the drift is structural, not just ratio.
    public var graphSummaryCalls: Int = 0

    public init() {}

    public init(graphCalls: Int, fileReadCalls: Int, graphSummaryCalls: Int) {
        self.graphCalls = graphCalls
        self.fileReadCalls = fileReadCalls
        self.graphSummaryCalls = graphSummaryCalls
    }
}

public enum ToolUseCounter {
    /// Parse a `cli.event` payload and return what to add to the
    /// running counts. Returns a zero-delta `ToolUseCounts` if the
    /// event isn't an assistant message with tool_use blocks.
    /// Pinned by `tool-use-counter-parse` test.
    public static func deltaForCliEvent(_ data: Data) -> ToolUseCounts {
        struct Wire: Codable {
            let type: String
            struct Msg: Codable {
                struct Block: Codable {
                    let type: String
                    let name: String?
                }
                let content: [Block]?
            }
            let message: Msg?
        }
        guard let env = try? JSONDecoder().decode(Wire.self, from: data),
              env.type == "assistant",
              let blocks = env.message?.content
        else { return ToolUseCounts() }
        var out = ToolUseCounts()
        for block in blocks where block.type == "tool_use" {
            guard let name = block.name else { continue }
            if name.hasPrefix("mcp__marvin-graph__") {
                out.graphCalls += 1
                if name == "mcp__marvin-graph__graph_summary" {
                    out.graphSummaryCalls += 1
                }
            } else if name == "Read" || name == "Grep" || name == "Glob" {
                out.fileReadCalls += 1
            }
        }
        return out
    }

    /// Classify (graph_calls, file_reads, graph_summary_calls) into a
    /// health band. Boundaries tuned to the 2026-05-27 audit:
    ///
    ///   idle     — fewer than 5 total tool calls of either kind
    ///   healthy  — file:graph ratio ≤ 4:1
    ///   drifting — file:graph ratio in (4:1, 8:1]
    ///              OR ≥10 file reads with 0 graph_summary calls
    ///   critical — file:graph ratio > 8:1
    ///              OR ≥20 file reads with 0 graph_summary calls
    ///
    /// Pinned by `tool-use-counter-band` test.
    public static func band(_ counts: ToolUseCounts) -> ToolUseBand {
        let total = counts.graphCalls + counts.fileReadCalls
        if total < 5 { return .idle }
        let g = max(counts.graphCalls, 1) // avoid div-by-zero; treat 0 as 1
        let r = Double(counts.fileReadCalls) / Double(g)
        // Critical: extreme ratio OR many reads with zero orientation
        if r > 8.0 { return .critical }
        if counts.fileReadCalls >= 20 && counts.graphSummaryCalls == 0 {
            return .critical
        }
        // Drifting: moderate ratio OR moderate reads with no orient
        if r > 4.0 { return .drifting }
        if counts.fileReadCalls >= 10 && counts.graphSummaryCalls == 0 {
            return .drifting
        }
        return .healthy
    }
}
