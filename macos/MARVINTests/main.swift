// MARVINTests — small executable test runner for the pure helpers
// that ADR-0022 introduces. We don't use XCTest / Swift Testing
// because the user's local toolchain (Command Line Tools, no
// Xcode.app) doesn't link those frameworks via SPM. A plain
// executable with hand-rolled assertions runs cleanly via
// `swift run MARVINTests`.
//
// Exit code 0 = all tests passed. Any failure prints the test name
// and exits non-zero so CI can gate on the run.
//
// New tests: declare them with `test("name") { ... }`. Inside the
// closure call `expect(actual, equals: expected, "label")` or
// `expect(condition, "label")` to record an assertion. Both flow
// through the same accumulator so a single failure doesn't stop
// the run — every test reports.

import Foundation
import MARVINLogic

// MARK: - Tiny test harness

private struct TestFailure {
    let suite: String
    let test: String
    let label: String
    let detail: String
}

private final class TestRunner {
    var currentSuite: String = ""
    var currentTest: String = ""
    var failures: [TestFailure] = []
    var passedAssertions: Int = 0

    func test(_ name: String, _ body: () -> Void) {
        currentTest = name
        body()
    }

    func suite(_ name: String, _ body: () -> Void) {
        currentSuite = name
        body()
        currentSuite = ""
    }

    func expect<T: Equatable>(_ actual: T, equals expected: T, _ label: String) {
        if actual == expected {
            passedAssertions += 1
        } else {
            failures.append(TestFailure(
                suite: currentSuite,
                test: currentTest,
                label: label,
                detail: "expected \(expected) but got \(actual)"
            ))
        }
    }

    func expect(_ condition: Bool, _ label: String) {
        if condition {
            passedAssertions += 1
        } else {
            failures.append(TestFailure(
                suite: currentSuite,
                test: currentTest,
                label: label,
                detail: "condition was false"
            ))
        }
    }
}

private let runner = TestRunner()

// MARK: - context-tokens (ADR-0022 §2)
//
// Pin the cli.event JSON parser. The load-bearing decision is the
// EXCLUSION of `cache_creation_input_tokens` from the resident-token
// figure — those bytes are being WRITTEN to cache for the next turn,
// not bytes the model walked this turn, so summing them double-counts
// on re-cache turns.

runner.suite("context-tokens") {
    runner.test("non-assistant events return nil") {
        let json = #"{"type":"system","subtype":"init","session_id":"s1"}"#
        let result = ContextUsageReader.read(cliEventData: Data(json.utf8))
        runner.expect(result.resident == nil, "resident should be nil")
        runner.expect(result.billable == nil, "billable should be nil")
    }

    runner.test("resident = cache_read + input") {
        let json = #"""
        {"type":"assistant","message":{"usage":{"cache_read_input_tokens":142000,"input_tokens":800,"output_tokens":1200,"cache_creation_input_tokens":5000}}}
        """#
        let result = ContextUsageReader.read(cliEventData: Data(json.utf8))
        runner.expect(result.resident, equals: 142_800, "resident sum")
    }

    runner.test("resident must NOT include cache_creation") {
        let json = #"""
        {"type":"assistant","message":{"usage":{"cache_read_input_tokens":50000,"input_tokens":500,"cache_creation_input_tokens":100000}}}
        """#
        let result = ContextUsageReader.read(cliEventData: Data(json.utf8))
        runner.expect(result.resident, equals: 50_500, "load-bearing exclusion")
        runner.expect(result.resident != 150_500, "resident must not be cache_creation-inclusive")
    }

    runner.test("billable = cache_creation + input") {
        let json = #"""
        {"type":"assistant","message":{"usage":{"cache_read_input_tokens":50000,"input_tokens":500,"cache_creation_input_tokens":8000}}}
        """#
        let result = ContextUsageReader.read(cliEventData: Data(json.utf8))
        runner.expect(result.billable, equals: 8_500, "billable sum")
    }

    runner.test("missing usage returns nil") {
        let json = #"{"type":"assistant","message":{}}"#
        let result = ContextUsageReader.read(cliEventData: Data(json.utf8))
        runner.expect(result.resident == nil, "no usage → no resident")
        runner.expect(result.billable == nil, "no usage → no billable")
    }

    runner.test("all-zero usage returns nil (no signal yet)") {
        let json = #"""
        {"type":"assistant","message":{"usage":{"cache_read_input_tokens":0,"input_tokens":0,"cache_creation_input_tokens":0}}}
        """#
        let result = ContextUsageReader.read(cliEventData: Data(json.utf8))
        runner.expect(result.resident == nil, "all-zero suppresses signal")
        runner.expect(result.billable == nil, "all-zero suppresses signal")
    }
}

// MARK: - context-band (ADR-0022 §2)
//
// Pin the four-band ramp boundaries. Tuned for Sonnet 4.x's 200K
// window and the user's reported pain point at ~145K.

runner.suite("context-band") {
    runner.test("band boundaries — 40K / 80K / 140K") {
        runner.expect(ContextUsageReader.band(forTokens: 0) == .healthy, "0 → healthy")
        runner.expect(ContextUsageReader.band(forTokens: 39_999) == .healthy, "39_999 → healthy")
        runner.expect(ContextUsageReader.band(forTokens: 40_000) == .climbing, "40_000 → climbing")
        runner.expect(ContextUsageReader.band(forTokens: 79_999) == .climbing, "79_999 → climbing")
        runner.expect(ContextUsageReader.band(forTokens: 80_000) == .high, "80_000 → high")
        runner.expect(ContextUsageReader.band(forTokens: 139_999) == .high, "139_999 → high")
        runner.expect(ContextUsageReader.band(forTokens: 140_000) == .critical, "140_000 → critical")
        runner.expect(ContextUsageReader.band(forTokens: 200_000) == .critical, "200_000 → critical")
    }

    runner.test("window-relative band scales to the model's window") {
        // 200K window — fractions land on the legacy 40K/80K/140K marks.
        runner.expect(ContextUsageReader.band(forTokens: 39_999, window: 200_000) == .healthy, "200K: 39_999 → healthy")
        runner.expect(ContextUsageReader.band(forTokens: 80_000, window: 200_000) == .high, "200K: 80_000 → high")
        runner.expect(ContextUsageReader.band(forTokens: 140_000, window: 200_000) == .critical, "200K: 140_000 → critical")
        // 1M window — 140K is now only 14%, comfortably healthy.
        runner.expect(ContextUsageReader.band(forTokens: 140_000, window: 1_000_000) == .healthy, "1M: 140_000 → healthy")
        runner.expect(ContextUsageReader.band(forTokens: 450_000, window: 1_000_000) == .high, "1M: 450K → high")
        runner.expect(ContextUsageReader.band(forTokens: 750_000, window: 1_000_000) == .critical, "1M: 750K → critical")
        // Degenerate window falls back to 200K.
        runner.expect(ContextUsageReader.band(forTokens: 150_000, window: 0) == .critical, "0 window → 200K fallback")
    }

    runner.test("contextWindow resolves the [1m] marker") {
        runner.expect(ContextUsageReader.contextWindow(forModelId: "claude-opus-4-8[1m]") == 1_000_000, "[1m] → 1M")
        runner.expect(ContextUsageReader.contextWindow(forModelId: "claude-opus-4-8") == 200_000, "plain → 200K")
        runner.expect(ContextUsageReader.contextWindow(forModelId: nil) == 200_000, "nil → 200K")
    }

    runner.test("band hint copy is stable") {
        runner.expect(ContextBand.healthy.hint, equals: "Context healthy", "healthy hint")
        runner.expect(ContextBand.climbing.hint, equals: "Climbing — long sessions slow", "climbing hint")
        runner.expect(ContextBand.high.hint, equals: "High — decisions getting slow", "high hint")
        runner.expect(ContextBand.critical.hint, equals: "Approaching limit — start a new session", "critical hint")
    }
}

// MARK: - tool-use-counter (2026-05-27 graphify-drift audit)
//
// Pin the cli.event parser and the band classifier. The audit found
// that MARVIN was treating `graph_search` as a fancier grep and
// bypassing the rest of the graphify protocol, producing ~7:1 file-ops
// to graph-ops drift across a week of sessions. This chip surfaces
// that ratio live; the band thresholds are tuned for the observed
// drift profile.

runner.suite("tool-use-counter-parse") {
    runner.test("non-assistant events return zero delta") {
        let json = #"{"type":"system","subtype":"init","session_id":"s1"}"#
        let delta = ToolUseCounter.deltaForCliEvent(Data(json.utf8))
        runner.expect(delta, equals: ToolUseCounts(), "system event → zero delta")
    }

    runner.test("graph_summary counts in both totals") {
        let json = #"""
        {"type":"assistant","message":{"content":[
          {"type":"tool_use","name":"mcp__marvin-graph__graph_summary","id":"a"}
        ]}}
        """#
        let delta = ToolUseCounter.deltaForCliEvent(Data(json.utf8))
        runner.expect(delta.graphCalls, equals: 1, "counts toward graph total")
        runner.expect(delta.graphSummaryCalls, equals: 1, "and toward summary total")
        runner.expect(delta.fileReadCalls, equals: 0, "not a file read")
    }

    runner.test("graph_search counts as graph but NOT as summary") {
        let json = #"""
        {"type":"assistant","message":{"content":[
          {"type":"tool_use","name":"mcp__marvin-graph__graph_search","id":"a"}
        ]}}
        """#
        let delta = ToolUseCounter.deltaForCliEvent(Data(json.utf8))
        runner.expect(delta.graphCalls, equals: 1, "graph_search is a graph call")
        runner.expect(delta.graphSummaryCalls, equals: 0, "but NOT a summary call")
    }

    runner.test("Read/Grep/Glob count as file reads") {
        let json = #"""
        {"type":"assistant","message":{"content":[
          {"type":"tool_use","name":"Read","id":"a"},
          {"type":"tool_use","name":"Grep","id":"b"},
          {"type":"tool_use","name":"Glob","id":"c"}
        ]}}
        """#
        let delta = ToolUseCounter.deltaForCliEvent(Data(json.utf8))
        runner.expect(delta.fileReadCalls, equals: 3, "all three count")
        runner.expect(delta.graphCalls, equals: 0, "none are graph calls")
    }

    runner.test("Bash / Edit / Write do NOT count") {
        let json = #"""
        {"type":"assistant","message":{"content":[
          {"type":"tool_use","name":"Bash","id":"a"},
          {"type":"tool_use","name":"Edit","id":"b"},
          {"type":"tool_use","name":"Write","id":"c"}
        ]}}
        """#
        let delta = ToolUseCounter.deltaForCliEvent(Data(json.utf8))
        runner.expect(delta, equals: ToolUseCounts(), "mutators are off-axis for this chip")
    }
}

runner.suite("tool-use-counter-band") {
    runner.test("low totals → idle") {
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 1, fileReadCalls: 2, graphSummaryCalls: 0))
        runner.expect(band == .idle, "3 total → idle")
    }

    runner.test("balanced ratio → healthy") {
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 5, fileReadCalls: 10, graphSummaryCalls: 1))
        runner.expect(band == .healthy, "2:1 file:graph with orient → healthy")
    }

    runner.test("ratio above 4:1 → drifting") {
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 2, fileReadCalls: 12, graphSummaryCalls: 1))
        runner.expect(band == .drifting, "6:1 file:graph → drifting")
    }

    runner.test("ratio above 8:1 → critical") {
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 2, fileReadCalls: 20, graphSummaryCalls: 1))
        runner.expect(band == .critical, "10:1 file:graph → critical")
    }

    runner.test("no graph_summary after 10 reads → drifting (orient-missing rule)") {
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 5, fileReadCalls: 10, graphSummaryCalls: 0))
        runner.expect(band == .drifting, "10 reads with 0 summary trips the orient check")
    }

    runner.test("no graph_summary after 20 reads → critical (orient-missing rule)") {
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 8, fileReadCalls: 20, graphSummaryCalls: 0))
        runner.expect(band == .critical, "20 reads with 0 summary tips to critical")
    }

    runner.test("zero graph calls but reads under 10 → idle / healthy") {
        // Edge case: a turn with 4 reads and 0 graph calls is below the
        // "idle" floor (< 5 total) so we don't flag it.
        let band = ToolUseCounter.band(ToolUseCounts(graphCalls: 0, fileReadCalls: 4, graphSummaryCalls: 0))
        runner.expect(band == .idle, "below total floor → idle, no signal")
    }
}

// MARK: - scope-met (ADR-0022 §3)
//
// Pin the Scope-met sentinel detector. The personality emits an
// HTML-comment marker on every real-work turn close so the chat UI
// can render the session-hygiene chip strip reliably regardless of
// personality wording drift. Detection is substring match — the
// sentinel string is unique enough that an accidental occurrence in
// normal prose is essentially impossible.

runner.suite("scope-met") {
    runner.test("sentinel is detected in canonical Phase-7 close") {
        let text = """
        **Scope met:**
        - Wired the X handler
        - Added the Y test

        Anything else, or should I stop?
        <!-- marvin:scope-met -->
        """
        runner.expect(ScopeMetDetector.isPresent(in: text), "canonical close detected")
    }

    runner.test("plain prose does NOT match") {
        let text = """
        I think we should next address scope but I'm not sure
        what you mean by met.
        """
        runner.expect(!ScopeMetDetector.isPresent(in: text), "false positive guard")
    }

    runner.test("sentinel survives leading/trailing whitespace") {
        let text = "   \n\n<!-- marvin:scope-met -->   \n  "
        runner.expect(ScopeMetDetector.isPresent(in: text), "whitespace-tolerant")
    }

    runner.test("summary extracts bullets joined with semicolons") {
        let text = """
        **Scope met:**
        - Wired the X handler
        - Added the Y test
        - Verified Z behaviour locally

        Anything else, or should I stop?
        <!-- marvin:scope-met -->
        """
        let summary = ScopeMetSummary.extract(from: text)
        runner.expect(summary.contains("Wired the X handler"), "first bullet")
        runner.expect(summary.contains("Added the Y test"), "second bullet")
        runner.expect(summary.contains("Verified Z behaviour locally"), "third bullet")
        runner.expect(summary.contains(";"), "bullets joined with semicolons")
    }

    runner.test("summary handles fast-path one-liner close") {
        let text = "scope met: dropped the dead exception clause"
        let summary = ScopeMetSummary.extract(from: text)
        runner.expect(!summary.isEmpty, "fallback path emits something")
        runner.expect(summary.contains("dropped the dead"), "preserves the message body")
    }

    runner.test("summary is prefixed with an ISO date") {
        let text = """
        **Scope met:**
        - Did the thing
        <!-- marvin:scope-met -->
        """
        let summary = ScopeMetSummary.extract(from: text)
        // YYYY-MM-DD prefix; we don't pin the exact date but check
        // shape (4 digits + dash + 2 + dash + 2).
        let prefix = String(summary.prefix(10))
        let parts = prefix.components(separatedBy: "-")
        runner.expect(parts.count == 3, "ISO-date shape")
        runner.expect(parts[0].count == 4, "year is 4 digits")
        runner.expect(parts[1].count == 2, "month is 2 digits")
        runner.expect(parts[2].count == 2, "day is 2 digits")
    }
}

runner.suite("DurationFormat") {
    runner.test("sub-second renders fractional") {
        runner.expect(DurationFormat.humanize(ms: 0), equals: "0.00s", "0ms")
        runner.expect(DurationFormat.humanize(ms: 420), equals: "0.42s", "420ms")
        runner.expect(DurationFormat.humanize(ms: 999), equals: "1s", "999ms rounds up")
    }

    runner.test("under a minute shows seconds only") {
        runner.expect(DurationFormat.humanize(ms: 1_000), equals: "1s", "1s exact")
        runner.expect(DurationFormat.humanize(ms: 12_300), equals: "12s", "12.3s rounds down")
        runner.expect(DurationFormat.humanize(ms: 12_500), equals: "13s", "12.5s rounds up")
        runner.expect(DurationFormat.humanize(ms: 59_499), equals: "59s", "just under 1m")
    }

    runner.test("under an hour shows m + s") {
        runner.expect(DurationFormat.humanize(ms: 60_000), equals: "1m 0s", "1m exact")
        runner.expect(DurationFormat.humanize(ms: 75_000), equals: "1m 15s", "1m 15s")
        runner.expect(DurationFormat.humanize(ms: 258_167), equals: "4m 18s", "the screenshot case")
        runner.expect(DurationFormat.humanize(ms: 3_599_000), equals: "59m 59s", "just under 1h")
    }

    runner.test("an hour and over shows h + m + s") {
        runner.expect(DurationFormat.humanize(ms: 3_600_000), equals: "1h 0m 0s", "1h exact")
        runner.expect(DurationFormat.humanize(ms: 630_885), equals: "10m 31s", "the original screenshot case")
        runner.expect(DurationFormat.humanize(ms: 7_290_000), equals: "2h 1m 30s", "2h 1m 30s")
        runner.expect(DurationFormat.humanize(ms: 90_061_000), equals: "25h 1m 1s", "longer than a day still renders")
    }

    runner.test("negative is clamped to zero") {
        runner.expect(DurationFormat.humanize(ms: -1), equals: "0.00s", "-1ms → 0.00s")
        runner.expect(DurationFormat.humanize(ms: -5_000), equals: "0.00s", "-5s → 0.00s")
    }
}

// MARK: - run + report

if runner.failures.isEmpty {
    print("MARVINTests · \(runner.passedAssertions) assertions passed across all suites")
    exit(0)
} else {
    for failure in runner.failures {
        print("FAIL [\(failure.suite)] \(failure.test) — \(failure.label): \(failure.detail)")
    }
    print("\nMARVINTests · \(runner.passedAssertions) assertions passed, \(runner.failures.count) failed")
    exit(1)
}
