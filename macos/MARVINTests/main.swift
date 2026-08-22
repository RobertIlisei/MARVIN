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

// Fixed zone so the assertions don't depend on the test machine's TZ.
private let utc = TimeZone(identifier: "UTC")!

runner.suite("ClockFormat") {
    runner.test("ISO with fractional seconds renders HH:mm:ss") {
        runner.expect(ClockFormat.time(iso: "2026-07-16T17:45:40.123Z", timeZone: utc),
                      equals: "17:45:40", "Node toISOString() shape")
    }

    runner.test("ISO without fractional seconds also parses") {
        runner.expect(ClockFormat.time(iso: "2026-07-16T17:45:40Z", timeZone: utc),
                      equals: "17:45:40", "plain internet-date-time")
    }

    runner.test("zone offset is applied") {
        // 17:45:40Z is 20:45:40 in +03:00.
        let plus3 = TimeZone(secondsFromGMT: 3 * 3_600)!
        runner.expect(ClockFormat.time(iso: "2026-07-16T17:45:40Z", timeZone: plus3),
                      equals: "20:45:40", "shifted into +03:00")
    }

    runner.test("unparseable input returns nil (footer degrades to duration-only)") {
        runner.expect(ClockFormat.time(iso: "not-a-timestamp", timeZone: utc) == nil,
                      equals: true, "garbage → nil")
        runner.expect(ClockFormat.time(iso: "", timeZone: utc) == nil,
                      equals: true, "empty → nil")
    }
}

// MARK: - PlanRebaseGuard (ADR-0052)

runner.suite("plan-rebase-guard") {
    // The plan whose corruption motivated the guard: 13 remediation steps.
    let planSteps = [
        "G-1 shared disclaimer fragment rendering in three templates",
        "G-1-retro count already-issued PDFs without the disclaimer",
        "G-2 acquisition run the pdf skill on the fetched guide",
        "CL-1 documents to report link status flip",
        "CL-2 calamity evidence pack signing",
        "CL-4 audit pack forensic fields",
        "CL-5 PPP human CSV parity",
        "CL-7 transport gate not null",
        "CL-8 postal lines",
        "readiness checklist for the 2027 mandate",
        "cross register feeder completeness pass",
        "gap register severity triage",
        "remediation roadmap decisions",
    ].map { PlanTextMatch.normalize($0) }

    runner.test("re-based foreign batch is distrusted (the 2026-07-02 corruption)") {
        // 18 micro-tasks about a different workstream, tagged [1]..[18] —
        // exactly what the model emitted after a manual interruption.
        let texts = (1...18).map { "Implement service wiring micro task number \($0) for the signal endpoint" }
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: Array(1...18), taggedTexts: texts, stepIds: planSteps)
        runner.expect(rebased, "tags 1..18 vs a 13-step plan with unrelated texts must be distrusted")
    }

    runner.test("legitimate partial update keeps its tags") {
        // Model updates steps 4 and 7 with reworded-but-related text.
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: [4, 7],
            taggedTexts: ["CL-1 documents to report link", "CL-5 PPP human CSV parity check"],
            stepIds: planSteps)
        runner.expect(!rebased, "a 2-item related update is below the batch floor and must pass")
    }

    runner.test("full-plan update with rewordings keeps its tags (K == step count)") {
        // Same count as the plan → never guarded, even with heavy rewording.
        let texts = (1...13).map { "step \($0) reworded entirely differently" }
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: Array(1...13), taggedTexts: texts, stepIds: planSteps)
        runner.expect(!rebased, "K == plan step count is a full-plan update, not a re-base")
    }

    runner.test("consecutive-from-1 batch whose texts MATCH their steps passes") {
        let texts = [
            "G-1 shared disclaimer fragment rendering in three templates",
            "G-1-retro count already-issued PDFs without the disclaimer",
            "G-2 acquisition run the pdf skill on the fetched guide",
        ]
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: [1, 2, 3], taggedTexts: texts, stepIds: planSteps)
        runner.expect(!rebased, "matching texts prove the ordinals are honest")
    }

    runner.test("non-consecutive tags are never treated as a re-base") {
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: [2, 5, 9],
            taggedTexts: ["unrelated a", "unrelated b", "unrelated c"],
            stepIds: planSteps)
        runner.expect(!rebased, "scattered ordinals are targeted updates; per-item handling applies")
    }

    runner.test("all-out-of-range consecutive batch is distrusted") {
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: [1, 2, 3, 4],
            taggedTexts: ["x1", "x2", "x3", "x4"],
            stepIds: ["only step one", "only step two"].map(PlanTextMatch.normalize))
        runner.expect(rebased, "4 consecutive tags against a 2-step plan with foreign texts")
    }

    runner.test("empty plan never trips the guard") {
        let rebased = PlanRebaseGuard.looksRebased(
            taggedSteps: [1, 2, 3], taggedTexts: ["a", "b", "c"], stepIds: [])
        runner.expect(!rebased, "no steps → nothing to corrupt → no guard")
    }
}

runner.suite("plan-text-match") {
    runner.test("normalize folds case, punctuation, and runs") {
        runner.expect(
            PlanTextMatch.normalize("  [7] Implement — the *Widget*!  "),
            equals: "7 implement the widget",
            "canonical form")
    }
    runner.test("matches requires length for containment") {
        runner.expect(PlanTextMatch.matches("abcdef", "abcdefgh"), "long containment matches")
        runner.expect(!PlanTextMatch.matches("ab", "abcd"), "short containment rejected")
    }
}

// MARK: - PlanProgress.reconcile (ADR-0049 — the roadmap-claimed logic test)

runner.suite("plan-reconcile") {
    func seedSteps() -> [PlanStep] {
        [
            PlanStep(content: "Design the gate policy for browser tools"),
            PlanStep(content: "Implement the confirm registry timeout"),
            PlanStep(content: "Verify the change end to end in the app"),
        ]
    }

    runner.test("[N] tag links a reworded item to its step by ordinal") {
        let out = PlanProgress.reconcile(
            steps: seedSteps(),
            with: [TodoItem(content: "[2] Registry timeout — totally reworded", status: "completed", activeForm: nil)])
        runner.expect(out[1].status, equals: "completed", "step 2 completes via its tag despite rewording")
        runner.expect(out[0].status, equals: "pending", "step 1 untouched")
        runner.expect(out.count, equals: 3, "no step added or erased")
    }

    runner.test("[N.M] tag nests as a sub-task of step N") {
        let out = PlanProgress.reconcile(
            steps: seedSteps(),
            with: [TodoItem(content: "[1.1] Enumerate the observational tools", status: "in_progress", activeForm: nil)])
        runner.expect(out[0].subtasks.count, equals: 1, "sub-task nested under step 1")
        runner.expect(out[0].subtasks.first?.key, equals: "1.1", "stable join key recorded")
        runner.expect(out[0].status, equals: "in_progress", "parent reflects sub-task activity")
    }

    runner.test("keyed sub-task re-matches by key across rewording (de-dup)") {
        var steps = PlanProgress.reconcile(
            steps: seedSteps(),
            with: [TodoItem(content: "[1.1] Enumerate the observational tools", status: "in_progress", activeForm: nil)])
        steps = PlanProgress.reconcile(
            steps: steps,
            with: [TodoItem(content: "[1.1] Enumerate observation-only browser tools (reworded)", status: "completed", activeForm: nil)])
        runner.expect(steps[0].subtasks.count, equals: 1, "rephrased keyed sub-task updates in place, no duplicate")
        runner.expect(steps[0].subtasks.first?.status, equals: "completed", "status carried by key match")
    }

    runner.test("untagged item falls back to fuzzy content match") {
        let out = PlanProgress.reconcile(
            steps: seedSteps(),
            with: [TodoItem(content: "Implement the confirm registry timeout", status: "in_progress", activeForm: nil)])
        runner.expect(out[1].status, equals: "in_progress", "fuzzy backstop still links untagged items")
    }

    runner.test("unmatched untagged item nests instead of clobbering the plan") {
        var steps = seedSteps()
        steps[0].status = "in_progress"
        let out = PlanProgress.reconcile(
            steps: steps,
            with: [TodoItem(content: "Chase a surprise dependency upgrade", status: "pending", activeForm: nil)])
        runner.expect(out.count, equals: 3, "plan steps never erased by a foreign item")
        runner.expect(out[0].subtasks.count, equals: 1, "unmatched work nests under the active step")
    }

    runner.test("full roll-up: all sub-tasks done completes the parent") {
        var steps = seedSteps()
        steps = PlanProgress.reconcile(steps: steps, with: [
            TodoItem(content: "[3.1] Drive the flow in the app", status: "completed", activeForm: nil),
            TodoItem(content: "[3.2] Capture the screenshot", status: "completed", activeForm: nil),
        ])
        runner.expect(steps[2].status, equals: "completed", "parent auto-completes when every sub-task is done")
    }

    runner.test("partial roll-up: mixed sub-tasks hold the parent at in_progress") {
        let out = PlanProgress.reconcile(steps: seedSteps(), with: [
            TodoItem(content: "[3.1] Drive the flow in the app", status: "completed", activeForm: nil),
            TodoItem(content: "[3.2] Capture the screenshot", status: "pending", activeForm: nil),
        ])
        runner.expect(out[2].status, equals: "in_progress", "partial sub-task progress → in_progress, never completed")
    }
}

// MARK: - Hard completion invariant (ADR-0049 addendum — v0.1.50 claim)

runner.suite("plan-completion-invariant") {
    runner.test("model-declared completed is overridden while a sub-task is open") {
        var step = PlanStep(content: "Operator console panel", status: "pending")
        step.subtasks = [TodoItem(content: "DoD sub-item", status: "pending", activeForm: nil, key: "1.1")]
        let out = PlanProgress.reconcile(
            steps: [step],
            with: [TodoItem(content: "[1] Operator console panel", status: "completed", activeForm: nil)])
        runner.expect(out[0].status, equals: "in_progress",
                      "a step owning open sub-tasks can never read completed (the step-[10] bug)")
    }

    runner.test("completed iff EVERY sub-task completed") {
        var step = PlanStep(content: "Operator console panel", status: "pending")
        step.subtasks = [
            TodoItem(content: "DoD sub-item", status: "completed", activeForm: nil, key: "1.1"),
            TodoItem(content: "Tests sub-item", status: "completed", activeForm: nil, key: "1.2"),
        ]
        let out = PlanProgress.reconcile(steps: [step], with: [])
        runner.expect(out[0].status, equals: "completed", "all sub-tasks done → parent completed")
    }

    runner.test("all-pending sub-tasks with a pending parent stay pending") {
        var step = PlanStep(content: "Operator console panel", status: "pending")
        step.subtasks = [TodoItem(content: "DoD sub-item", status: "pending", activeForm: nil, key: "1.1")]
        let out = PlanProgress.reconcile(steps: [step], with: [])
        runner.expect(out[0].status, equals: "pending", "no activity anywhere → pending, not in_progress")
    }

    runner.test("steps without sub-tasks keep their model-declared status") {
        let out = PlanProgress.reconcile(
            steps: [PlanStep(content: "A leaf step", status: "pending")],
            with: [TodoItem(content: "[1] A leaf step", status: "completed", activeForm: nil)])
        runner.expect(out[0].status, equals: "completed", "invariant only governs steps that own sub-tasks")
    }
}

// MARK: - ChatMarkdown (assistant output rendering)

runner.suite("ChatMarkdown") {
    runner.test("headings, paragraphs and rules split correctly") {
        let out = ChatMarkdown.parse("## Part 1 — Findings\n\nSome prose here.\n\n---\n")
        runner.expect(out.count, equals: 3, "three blocks")
        runner.expect(out[0] == .heading(level: 2, text: "Part 1 — Findings"), "h2 parsed")
        runner.expect(out[1] == .paragraph("Some prose here."), "paragraph parsed")
        runner.expect(out[2] == .rule, "rule parsed")
    }

    runner.test("a hash without a space is prose, not a heading") {
        let out = ChatMarkdown.parse("#hashtag not a heading")
        runner.expect(out[0] == .paragraph("#hashtag not a heading"), "no false heading")
    }

    runner.test("fenced code keeps its language and body verbatim") {
        let out = ChatMarkdown.parse("```swift\nlet x = 1\n// ## not a heading\n```")
        runner.expect(out.count, equals: 1, "single code block")
        runner.expect(
            out[0] == .code(language: "swift", content: "let x = 1\n// ## not a heading"),
            "markdown inside a fence is not re-parsed")
    }

    runner.test("pipe table parses headers and rows") {
        let md = "| Before | After |\n| --- | --- |\n| a | b |\n| c | d |"
        let out = ChatMarkdown.parse(md)
        runner.expect(
            out[0] == .table(headers: ["Before", "After"], rows: [["a", "b"], ["c", "d"]]),
            "table parsed")
    }

    runner.test("pipes without a delimiter row stay prose") {
        let out = ChatMarkdown.parse("| this is just | text with pipes")
        runner.expect(out[0] == .paragraph("| this is just | text with pipes"), "no false table")
    }

    runner.test("bullet and ordered lists") {
        let bullets = ChatMarkdown.parse("- one\n- two")
        runner.expect(bullets[0] == .list(items: ["one", "two"], ordered: false), "bullets")
        let ordered = ChatMarkdown.parse("1. first\n2. second")
        runner.expect(ordered[0] == .list(items: ["first", "second"], ordered: true), "ordered")
    }

    runner.test("blockquote joins contiguous lines") {
        let out = ChatMarkdown.parse("> line one\n> line two")
        runner.expect(out[0] == .quote("line one\nline two"), "quote joined")
    }

    runner.test("plain text with no markdown yields one paragraph") {
        let out = ChatMarkdown.parse("just a sentence")
        runner.expect(out.count, equals: 1, "one block")
        runner.expect(out[0] == .paragraph("just a sentence"), "unchanged")
    }

    runner.test("language tags map to highlighter extensions") {
        runner.expect(ChatMarkdown.fileExtension(forLanguage: "TypeScript"), equals: "ts", "ts")
        runner.expect(ChatMarkdown.fileExtension(forLanguage: "sh"), equals: "sh", "shell")
        runner.expect(ChatMarkdown.fileExtension(forLanguage: "brainfuck") == nil, "unknown → nil")
    }
}

// MARK: - run + report

// MARK: - MarkdownLinks (clickable chat output)

// MARK: - FileTree (2026-08-06)
//
// The file tree crashed the app FOUR times, each through SwiftUI's outline
// coordinator disagreeing with NSOutlineView about a tree it couldn't be kept
// consistent with. Every previous fix was verified by running the app and
// waiting to see whether it died again. The model + flattening now live in
// MARVINLogic precisely so the invariants are pinned here instead.

func node(_ path: String) -> FileNode {
    FileNode(name: (path as NSString).lastPathComponent, path: path, type: "file", children: nil)
}
func dir(_ path: String, _ kids: [FileNode]) -> FileNode {
    FileNode(name: (path as NSString).lastPathComponent, path: path, type: "dir", children: kids)
}

runner.suite("FileTree — branch-ness + identity") {
    runner.test("a directory with children is a branch; a file is not") {
        runner.expect(dir("/p/src", [node("/p/src/a.swift")]).isOutlineBranch, "dir with kids")
        runner.expect(!node("/p/a.swift").isOutlineBranch, "file")
    }

    runner.test("an EMPTY directory is a leaf, not an expandable branch") {
        // Regression: a non-nil empty children array used to reach OutlineGroup
        // and trap it. It now simply has no disclosure chevron.
        runner.expect(!dir("/p/build", []).isOutlineBranch, "empty dir")
        runner.expect(
            !FileNode(name: "cache", path: "/p/cache", type: "dir", children: nil).isOutlineBranch,
            "dir with nil children"
        )
    }

    runner.test("emptying a directory changes its row identity") {
        // Regression (crash report 2026-08-03): id was the bare path, so a
        // folder could flip branch -> leaf while keeping the same identity.
        let before = dir("/p/build", [node("/p/build/out.o")])
        let after = dir("/p/build", [])
        runner.expect(before.id != after.id, "branch and leaf ids differ")
        runner.expect(after.id, equals: "/p/build", "leaf id is the bare path")
        runner.expect(before.id, equals: "/p/build/", "branch id is suffixed")
    }

    runner.test("identical walks produce identical ids") {
        let a = dir("/p/src", [node("/p/src/a.swift")])
        let b = dir("/p/src", [node("/p/src/a.swift")])
        runner.expect(a.id, equals: b.id, "stable across refetch")
    }

    runner.test("deduplicatedTreeWide prunes a path repeated anywhere") {
        // ADR-0056 — a symlink loop can emit the same path twice.
        let tree = [
            dir("/p", [node("/p/a.swift"), node("/p/a.swift")]),
            dir("/p", [node("/p/b.swift")]),
        ].deduplicatedTreeWide()
        runner.expect(tree.count, equals: 1, "duplicate root pruned")
        runner.expect(tree[0].children?.count, equals: 1, "duplicate child pruned")
    }
}

runner.suite("FileTree — flattening") {
    let tree = [
        dir("/p/src", [
            node("/p/src/a.swift"),
            dir("/p/src/ui", [node("/p/src/ui/b.swift")]),
        ]),
        dir("/p/build", []),
        node("/p/README.md"),
    ]

    runner.test("collapsed: only roots, all at depth 0") {
        let rows = flattenFileTree(tree, expanded: [])
        runner.expect(rows.map(\.node.path), equals: ["/p/src", "/p/build", "/p/README.md"], "roots only")
        runner.expect(rows.allSatisfy { $0.depth == 0 }, "all depth 0")
        runner.expect(rows.allSatisfy { !$0.isExpanded }, "none expanded")
    }

    runner.test("expanding one level reveals its children at depth 1") {
        let rows = flattenFileTree(tree, expanded: ["/p/src"])
        runner.expect(
            rows.map(\.node.path),
            equals: ["/p/src", "/p/src/a.swift", "/p/src/ui", "/p/build", "/p/README.md"],
            "children spliced in order"
        )
        runner.expect(rows[1].depth, equals: 1, "child depth")
        runner.expect(rows[0].isExpanded, "parent marked open")
    }

    runner.test("nested expansion nests depth") {
        let rows = flattenFileTree(tree, expanded: ["/p/src", "/p/src/ui"])
        runner.expect(rows.first { $0.node.path == "/p/src/ui/b.swift" }?.depth, equals: 2, "grandchild depth")
    }

    runner.test("an empty directory is never expandable, even if in the expanded set") {
        // The state could name it after it emptied; it must not claim a chevron.
        let rows = flattenFileTree(tree, expanded: ["/p/build"])
        let build = rows.first { $0.node.path == "/p/build" }
        runner.expect(build?.isExpandable, equals: false, "no chevron")
        runner.expect(build?.isExpanded, equals: false, "not open")
        runner.expect(rows.count, equals: 3, "emitted no phantom children")
    }

    runner.test("expansion survives a directory losing and regaining children") {
        // The crash case, as a state transition. Expansion is path-keyed, so
        // the folder is still open once its children come back.
        let expanded: Set<String> = ["/p/src"]
        let emptied = [dir("/p/src", [])]
        let refilled = [dir("/p/src", [node("/p/src/a.swift")])]
        runner.expect(flattenFileTree(emptied, expanded: expanded).count, equals: 1, "leaf while empty")
        let back = flattenFileTree(refilled, expanded: expanded)
        runner.expect(back.count, equals: 2, "reopens when refilled")
        runner.expect(back[0].isExpanded, "still expanded")
    }

    runner.test("a cyclic tree terminates instead of recursing forever") {
        // A symlink loop the sidecar failed to reject must not hang the app.
        let loop = dir("/p/a", [dir("/p/a", [node("/p/a/x.swift")])])
        let rows = flattenFileTree([loop], expanded: ["/p/a"])
        runner.expect(rows.count, equals: 1, "repeated path visited once")
    }

    runner.test("allDirectoryPaths finds every expandable directory") {
        runner.expect(allDirectoryPaths(tree), equals: ["/p/src", "/p/src/ui"], "empty dir excluded")
    }
}

runner.suite("MarkdownLinks") {
    // Every path under this fake tree "exists"; nothing else does.
    let exists: (String) -> Bool = { $0.hasPrefix("/proj/real") }

    runner.test("bare URLs become links") {
        let spans = MarkdownLinks.webSpans(in: "see https://example.com/a_b?q=1 now")
        runner.expect(spans.count, equals: 1, "one web span")
        runner.expect(spans[0].url.absoluteString, equals: "https://example.com/a_b?q=1", "full URL captured")
    }

    runner.test("trailing sentence punctuation is not part of the URL") {
        let spans = MarkdownLinks.webSpans(in: "docs at https://example.com/x.")
        runner.expect(spans[0].url.absoluteString, equals: "https://example.com/x", "period excluded")
    }

    runner.test("text with no URL yields nothing") {
        runner.expect(MarkdownLinks.webSpans(in: "no links at all here").isEmpty, "no spans")
    }

    runner.test("file reference with a line number carries the line") {
        let spans = MarkdownLinks.fileSpans(
            in: "broken at real/Login.tsx:61-69 today",
            workDir: "/proj",
            exists: exists
        )
        runner.expect(spans.count, equals: 1, "one file span")
        runner.expect(spans[0].url.scheme ?? "", equals: MarkdownLinks.fileScheme, "private scheme")
        runner.expect(spans[0].url.path, equals: "/proj/real/Login.tsx", "resolved against workDir")
        runner.expect(spans[0].url.query ?? "", equals: "line=61", "start line carried")
    }

    runner.test("file reference without a line number still links") {
        let spans = MarkdownLinks.fileSpans(in: "see real/README.md", workDir: "/proj", exists: exists)
        runner.expect(spans.count, equals: 1, "one file span")
        runner.expect(spans[0].url.query == nil, "no line query")
    }

    runner.test("paths that do not resolve are left as plain text") {
        let spans = MarkdownLinks.fileSpans(in: "maybe ghost/Nope.swift:12", workDir: "/proj", exists: exists)
        runner.expect(spans.isEmpty, "no dead links")
    }

    runner.test("absolute paths bypass workDir resolution") {
        let spans = MarkdownLinks.fileSpans(in: "at /proj/real/a.ts:9", workDir: "/other", exists: exists)
        runner.expect(spans.count, equals: 1, "absolute path linked")
        runner.expect(spans[0].url.path, equals: "/proj/real/a.ts", "used as-is")
    }

    runner.test("no workDir means no file links") {
        runner.expect(MarkdownLinks.fileSpans(in: "real/a.ts", workDir: nil, exists: exists).isEmpty, "inert")
    }

    runner.test("a URL is not mistaken for a file path") {
        // `example.com/x.ts` looks path-shaped; the web span must win and the
        // file matcher must not resolve a fragment of a URL.
        let spans = MarkdownLinks.fileSpans(in: "https://example.com/real/a.ts", workDir: "/proj", exists: exists)
        runner.expect(spans.isEmpty, "no file span inside a URL")
    }
}


// MARK: - Plan de-duplication (ADR-0068)
//
// Measured on a real corrupted plan (agri-saas-platform, 2026-08-17):
// `.marvin/plans/grouped-backlog-fix-pass.md` had grown to 347 checkbox
// bullets / 38,980 bytes, with 24 duplicated texts, 14 IDs reused for
// DIFFERENT work, and 7 bullets present BOTH checked and unchecked. The
// injected plan context was therefore self-contradictory, and the model
// reading it concluded — wrongly — that the plan "never was" a tracked plan
// and that real, merged work had been "fabricated".
//
// Cause: `mergeSubtasks` matches on equality or containment and APPENDS when
// both fail. A reworded sub-task is a new row. These strings are taken from
// the real file.

runner.suite("plan-dedupe") {
    let longA = "Milestone A (sweep-side): zilier_entries + documents widened match, dry-run counts, TDD RED-GREEN, DoD-completeness tests (purgeStorage chain + non-zero dry-run counts) — 41/41 green"
    let longB = "Milestone A (sweep-side): zilier_entries + documents widened match, TDD, DoD-completeness tests — 41/41 green"

    runner.test("the real reworded pair is recognised as the same work") {
        // Neither equal nor containing: this is exactly the pair that
        // produced a duplicate row in production.
        runner.expect(
            !PlanTextMatch.matches(PlanTextMatch.normalize(longA), PlanTextMatch.normalize(longB)),
            "precondition: old matcher does NOT catch this pair"
        )
        runner.expect(
            PlanTextMatch.sameWork(PlanTextMatch.normalize(longA), PlanTextMatch.normalize(longB)),
            "sameWork catches the reworded duplicate"
        )
    }

    runner.test("distinct milestones sharing a short prefix are NOT merged") {
        // The danger of prefix matching is collapsing real, separate work.
        let a = PlanTextMatch.normalize("Milestone 2: wire ActivityController to the resolver")
        let b = PlanTextMatch.normalize("Milestone 2: wire TreatmentController to the resolver")
        runner.expect(!PlanTextMatch.sameWork(a, b), "different controllers stay separate")
    }

    runner.test("short items are never merged on prefix alone") {
        let a = PlanTextMatch.normalize("Run make fast")
        let b = PlanTextMatch.normalize("Run make e2e")
        runner.expect(!PlanTextMatch.sameWork(a, b), "short similar items stay separate")
    }

    runner.test("dedupe collapses the reworded pair and keeps the richer text") {
        let items = [
            TodoItem(content: longA, status: "completed", activeForm: nil),
            TodoItem(content: longB, status: "completed", activeForm: nil),
        ]
        let (out, collapsed) = PlanProgress.dedupeSubtasks(items)
        runner.expect(out.count, equals: 1, "two rows become one")
        runner.expect(collapsed, equals: 1, "reports what it collapsed")
        runner.expect(out[0].content.count >= longA.count, "keeps the fuller wording")
    }

    runner.test("a contradictory pair resolves to the most recent statement") {
        // Same work listed completed, then listed pending again. Last write
        // wins — silently preferring 'completed' would mark undone work done.
        let items = [
            TodoItem(content: longA, status: "completed", activeForm: nil),
            TodoItem(content: longB, status: "pending", activeForm: nil),
        ]
        let (out, _) = PlanProgress.dedupeSubtasks(items)
        runner.expect(out.count, equals: 1, "collapsed")
        runner.expect(out[0].status, equals: "pending", "latest status wins")
    }

    runner.test("dedupe is order-preserving and idempotent") {
        let items = [
            TodoItem(content: "Alpha step doing the first distinct thing", status: "completed", activeForm: nil),
            TodoItem(content: longA, status: "completed", activeForm: nil),
            TodoItem(content: "Omega step doing the last distinct thing", status: "pending", activeForm: nil),
            TodoItem(content: longB, status: "completed", activeForm: nil),
        ]
        let (once, _) = PlanProgress.dedupeSubtasks(items)
        let (twice, again) = PlanProgress.dedupeSubtasks(once)
        runner.expect(once.count, equals: 3, "one duplicate removed")
        runner.expect(once[0].content.hasPrefix("Alpha"), "order preserved")
        runner.expect(once[2].content.hasPrefix("Omega"), "order preserved")
        runner.expect(again, equals: 0, "second pass finds nothing to collapse")
        runner.expect(twice.count, equals: 3, "idempotent")
    }

    runner.test("mergeSubtasks no longer appends a reworded duplicate") {
        // The regression itself: merging a reworded restatement must update
        // the existing row, not add a second one.
        let existing = [TodoItem(content: longA, status: "pending", activeForm: nil)]
        let out = PlanProgress.mergeSubtasks(existing, [TodoItem(content: longB, status: "completed", activeForm: nil)])
        runner.expect(out.count, equals: 1, "no duplicate row")
        runner.expect(out[0].status, equals: "completed", "status updated in place")
    }

    runner.test("keys still win over text when present") {
        let existing = [TodoItem(content: "Some work", status: "pending", activeForm: nil, key: "k1")]
        let out = PlanProgress.mergeSubtasks(existing, [TodoItem(content: "Rephrased entirely", status: "completed", activeForm: nil, key: "k1")])
        runner.expect(out.count, equals: 1, "keyed match still reconciles")
        runner.expect(out[0].status, equals: "completed", "status updated")
    }
}


// MARK: - Injected plan-context block (ADR-0068 addendum)
//
// Measured on the real `Grouped backlog fix pass` plan: 20 steps, 336
// sub-tasks, 61% already completed, rendered in full into EVERY turn —
// 36,694 chars (~9,173 tokens). Collapsing the completed ones halves it.
// This block is also what the model mis-read when it called genuine merged
// work "fabricated", so its wording is load-bearing, not cosmetic.

runner.suite("plan-context-block") {
    func sub(_ c: String, _ st: String) -> TodoItem {
        TodoItem(content: c, status: st, activeForm: nil)
    }
    func planWith(_ subs: [TodoItem], path: String? = "/proj/.marvin/plans/p.md") -> Plan {
        var step = PlanStep(content: "Wire the thing", status: "in_progress")
        step.subtasks = subs
        return Plan(id: "p", title: "P", text: "", path: path, steps: [step])
    }

    runner.test("returns nil when the plan has no steps") {
        let empty = Plan(id: "p", title: "P", text: "", path: nil, steps: [])
        runner.expect(PlanContextBlock.render(plan: empty) == nil, "no block for an empty plan")
    }

    runner.test("carries id and on-disk source so the plan is verifiable") {
        let out = PlanContextBlock.render(plan: planWith([sub("a", "pending")])) ?? ""
        runner.expect(out.contains("(id: p)"), "id present")
        runner.expect(out.contains("source: /proj/.marvin/plans/p.md"), "path present")
    }

    runner.test("says so honestly when the plan is not yet on disk") {
        let out = PlanContextBlock.render(plan: planWith([sub("a", "pending")], path: nil)) ?? ""
        runner.expect(out.contains("not yet written to disk"), "states the absence")
    }

    runner.test("does NOT collapse a small number of completed sub-tasks") {
        // Collapsing "1 of 2 complete" hides more than it saves.
        let out = PlanContextBlock.render(plan: planWith([
            sub("alpha done", "completed"),
            sub("beta open", "pending"),
        ])) ?? ""
        runner.expect(out.contains("alpha done"), "completed item still shown")
        runner.expect(!out.contains("of 2 sub-tasks complete"), "no summary line")
    }

    runner.test("collapses completed sub-tasks past the threshold, stating the count") {
        var subs = (1...5).map { sub("done item \($0)", "completed") }
        subs.append(sub("the open one", "pending"))
        let out = PlanContextBlock.render(plan: planWith(subs)) ?? ""
        runner.expect(out.contains("5 of 6 sub-tasks complete"), "count stated")
        runner.expect(!out.contains("done item 3"), "completed detail omitted")
        runner.expect(out.contains("the open one"), "open work always shown in full")
    }

    runner.test("omission can never read as 'not done'") {
        var subs = (1...5).map { sub("done \($0)", "completed") }
        subs.append(sub("open", "pending"))
        let out = PlanContextBlock.render(plan: planWith(subs)) ?? ""
        runner.expect(out.contains("a summarised item IS"), "explicitly states summarised == done")
        runner.expect(out.contains("do not redo it"), "tells the model not to redo it")
    }

    runner.test("PRESERVES original numbering after omitting completed items") {
        // Renumbering would silently move the model's own reference points and
        // make the block disagree with the file it cites.
        var subs = (1...5).map { sub("done \($0)", "completed") }
        subs.append(sub("sixth item, still open", "pending"))
        let out = PlanContextBlock.render(plan: planWith(subs)) ?? ""
        runner.expect(out.contains("1.6 sixth item"), "kept index 6, not renumbered to 1.1")
    }

    runner.test("an all-complete step summarises without a misleading suffix") {
        let out = PlanContextBlock.render(plan: planWith((1...5).map { sub("d\($0)", "completed") })) ?? ""
        runner.expect(out.contains("5 of 5 sub-tasks complete"), "count stated")
        runner.expect(!out.contains("the open ones follow"), "no promise of open items when there are none")
    }

    runner.test("in-progress sub-tasks are never collapsed") {
        var subs = (1...5).map { sub("done \($0)", "completed") }
        subs.append(sub("actively running", "in_progress"))
        let out = PlanContextBlock.render(plan: planWith(subs)) ?? ""
        runner.expect(out.contains("actively running"), "in-progress work stays visible")
        runner.expect(out.contains("[~]"), "in-progress glyph retained")
    }

    runner.test("collapsing materially shrinks a realistic plan") {
        var subs = (1...200).map { sub("completed sub-task number \($0) with a fairly long description", "completed") }
        subs.append(contentsOf: (1...10).map { sub("open sub-task \($0)", "pending") })
        let collapsed = (PlanContextBlock.render(plan: planWith(subs)) ?? "").count
        // Reference: the same plan with nothing collapsed.
        var openOnly = PlanStep(content: "Wire the thing", status: "in_progress")
        openOnly.subtasks = subs
        let full = subs.reduce(0) { $0 + $1.content.count + 12 }
        runner.expect(collapsed < full / 2, "collapsed block is less than half the full rendering")
    }
}


// MARK: - Plan file freshness stamp (ADR-0068 addendum 2)
//
// Observed 2026-08-17: a brand-new session found a plan on disk last modified
// Jul 28 — three weeks earlier — and offered it as "an in-flight plan … want me
// to resume at step 7?". `Read` does not surface mtime, so unchecked boxes were
// the only signal available, and unchecked means "never finished", not
// "current". The stamp puts the date in the file itself.

runner.suite("plan-file-stamp") {
    let day = DateFormatter()
    day.locale = Locale(identifier: "en_US_POSIX")
    day.timeZone = TimeZone(identifier: "UTC")
    day.dateFormat = "yyyy-MM-dd"
    let d1 = day.date(from: "2026-07-28")!
    let d2 = day.date(from: "2026-08-17")!

    runner.test("stamps the body with the date and the caveat") {
        let out = PlanFile.stamped("# Plan — X\n1. [ ] do it", date: d1)
        runner.expect(out.contains("2026-07-28"), "date present")
        runner.expect(out.contains("Unchecked boxes mean this plan was never"), "caveat present")
        runner.expect(out.contains("# Plan — X"), "body preserved")
    }

    runner.test("stripStamp round-trips to the original body") {
        let body = "# Plan — X\n1. [ ] do it"
        runner.expect(PlanFile.stripStamp(PlanFile.stamped(body, date: d1)), equals: body, "round-trip")
    }

    runner.test("stamping is idempotent — no stacking of trailers") {
        // Re-saving must replace the stamp, never append a second one.
        let once = PlanFile.stamped("# Plan", date: d1)
        let twice = PlanFile.stamped(once, date: d2)
        runner.expect(twice.components(separatedBy: PlanFile.stampMarker).count - 1, equals: 1, "exactly one stamp")
        runner.expect(twice.contains("2026-08-17"), "carries the NEW date")
        runner.expect(!twice.contains("2026-07-28"), "old date gone")
    }

    runner.test("an unstamped body strips to itself") {
        // The 303 pre-existing plan files have no stamp; stripping must be a no-op.
        let plain = "# Plan — legacy\n1. [x] done"
        runner.expect(PlanFile.stripStamp(plain), equals: plain, "unchanged")
    }

    runner.test("CHANGE DETECTION ignores the stamp") {
        // The load-bearing property: same body + different date must compare
        // equal, or every save rewrites the file and every plan looks fresh.
        let body = "# Plan — X\n1. [ ] step"
        let a = PlanFile.stamped(body, date: d1)
        let b = PlanFile.stamped(body, date: d2)
        runner.expect(PlanFile.stripStamp(a), equals: PlanFile.stripStamp(b), "stamp excluded from comparison")
        runner.expect(a != b, "the raw files DO differ (so a naive compare would churn)")
    }

    runner.test("a real body change is still detected") {
        let a = PlanFile.stamped("# Plan\n1. [ ] step", date: d1)
        let b = PlanFile.stamped("# Plan\n1. [x] step", date: d1)
        runner.expect(PlanFile.stripStamp(a) != PlanFile.stripStamp(b), "progress change detected")
    }
}


// MARK: - Step counting: nested bullets are sub-tasks, not steps (ADR-0068 add. 3)
//
// Observed 2026-08-19: MARVIN reported "Plan complete — all 6 top-level steps
// verified done" while the UI showed "1/12 · Paused" on the same plan. Both were
// right about different things. The lenient step regex (`^\s*` — any
// indentation) found 66 "steps" in a file with 6 numbered ones, because every
// indented sub-bullet was promoted to a top-level step.

runner.suite("plan-step-counting") {
    let plan = """
    # Plan — Retention sweep

    1. [ ] **Consolidate the research** into a per-kind schedule
       - [ ] **Sweep shape:** hardcoded per-kind sweep
       - [ ] **Garage deletion:** delete storage_ref and siblings
       - [ ] **Superseded chains:** deletion order for the self-FK
    2. [ ] **Draft the ADR** via the authoring skill
       - [x] decide sweep shape
       - [x] decide deletion order
    3. [ ] **Verify and close out:** make fast + make smoke
    """

    runner.test("counts only TOP-LEVEL markers as steps") {
        let steps = PlanParser.steps(from: plan)
        runner.expect(steps.count, equals: 3, "3 numbered steps, not 8")
    }

    runner.test("the promoted sub-bullets are gone from the step list") {
        let contents = PlanParser.steps(from: plan).map(\.content).joined(separator: " | ")
        runner.expect(!contents.contains("Sweep shape"), "nested bullet is not a step")
        runner.expect(!contents.contains("decide sweep shape"), "nested bullet is not a step")
        runner.expect(contents.contains("Consolidate the research"), "top-level step kept")
        runner.expect(contents.contains("Verify and close out"), "top-level step kept")
    }

    runner.test("a fully-bulleted top-level plan still parses") {
        let bulleted = "- [ ] First thing to do\n- [ ] Second thing to do"
        runner.expect(PlanParser.steps(from: bulleted).count, equals: 2, "top-level bullets count")
    }

    runner.test("FALLBACK: a plan that indents everything still yields steps") {
        // Zero steps would be worse than over-counting, so the lenient matcher
        // is retried when the strict pass finds nothing.
        let indented = "   - [ ] Only an indented item here\n   - [ ] And another one"
        runner.expect(PlanParser.steps(from: indented).count, equals: 2, "fallback engaged")
    }

    runner.test("PlanFile.render still overlays NESTED lines") {
        // The overlay legitimately marks sub-bullets; only step COUNTING changed.
        runner.expect(PlanParser.stepText(of: "   - [ ] a nested item") != nil, "nested still matches for render")
        runner.expect(PlanParser.stepText(of: "1. a top-level item") != nil, "top-level still matches")
    }
}


// MARK: - Plan file: no echoed duplicates, and step re-derivation (ADR-0068 add.3)
//
// (a) `PlanFile.render` injected a step's reconciled sub-tasks under its line
//     AND let the model's own nested bullets for the same items pass through —
//     duplicating every sub-task in the saved file.
// (b) The step-counting fix is prospective; a plan whose state was built by the
//     old parser keeps its inflated list, so the strip shows "1/12" for a 6-step
//     plan until the state is re-derived.

runner.suite("plan-file-dedupe-and-rederive") {
    func item(_ c: String, _ st: String = "completed") -> TodoItem {
        TodoItem(content: c, status: st, activeForm: nil)
    }

    let text = """
    # Plan — Retention

    1. Consolidate the research
       - decide sweep shape
       - decide deletion order
    2. Draft the ADR
    """

    runner.test("(a) an injected sub-task is not ALSO echoed from the text") {
        var s1 = PlanStep(content: "Consolidate the research", status: "in_progress")
        s1.subtasks = [item("decide sweep shape"), item("decide deletion order")]
        let plan = Plan(id: "p", title: "P", text: text, path: nil,
                        steps: [s1, PlanStep(content: "Draft the ADR", status: "pending")])
        let out = PlanFile.render(plan)
        let sweep = out.components(separatedBy: "decide sweep shape").count - 1
        let order = out.components(separatedBy: "decide deletion order").count - 1
        runner.expect(sweep, equals: 1, "sweep shape appears once, not twice")
        runner.expect(order, equals: 1, "deletion order appears once, not twice")
        runner.expect(out.contains("[x] decide sweep shape"), "the LIVE status survives")
    }

    runner.test("(a) a TOP-LEVEL line matching a sub-task name still survives") {
        // Only indented echoes are dropped; a real step must never vanish.
        var s1 = PlanStep(content: "Alpha", status: "in_progress")
        s1.subtasks = [item("Draft the ADR")]          // same text as step 2
        let plan = Plan(id: "p", title: "P",
                        text: "1. Alpha\n2. Draft the ADR", path: nil,
                        steps: [s1, PlanStep(content: "Draft the ADR", status: "pending")])
        let out = PlanFile.render(plan)
        runner.expect(out.contains("2."), "the top-level step line survives")
    }

    runner.test("(b) re-derive collapses promoted bullets back into sub-tasks") {
        // Stored state from the OLD parser: 4 "steps", 2 of them really nested.
        let stored = [
            PlanStep(content: "Consolidate the research", status: "in_progress"),
            PlanStep(content: "decide sweep shape", status: "completed"),
            PlanStep(content: "decide deletion order", status: "completed"),
            PlanStep(content: "Draft the ADR", status: "pending"),
        ]
        let fixed = PlanProgress.redriveSteps(text: text, existing: stored)
        runner.expect(fixed.count, equals: 2, "4 stored -> 2 real steps")
        runner.expect(fixed[0].subtasks.count, equals: 2, "both demoted under their parent")
        runner.expect(fixed[0].subtasks.allSatisfy { $0.status == "completed" },
                      "completed work is PRESERVED, not discarded")
        runner.expect(fixed[1].content, equals: "Draft the ADR", "later step kept in order")
    }

    runner.test("(b) a healthy plan is returned untouched") {
        let ok = [
            PlanStep(content: "Consolidate the research", status: "completed"),
            PlanStep(content: "Draft the ADR", status: "pending"),
        ]
        let out = PlanProgress.redriveSteps(text: text, existing: ok)
        runner.expect(out.count, equals: 2, "unchanged")
        runner.expect(out[0].status, equals: "completed", "status untouched")
    }

    runner.test("(b) never returns an empty plan when the text cannot be parsed") {
        let stored = [PlanStep(content: "Something", status: "completed")]
        let out = PlanProgress.redriveSteps(text: "prose with no list markers at all", existing: stored)
        runner.expect(out.count >= 1, "falls back rather than wiping the plan")
    }
}

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
