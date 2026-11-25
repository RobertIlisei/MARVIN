// PracticeScoreBand — what a finding's 0..1 score means, in a word.
//
// The 2026-11-24 review: a Practice card carried "0.67 / 1.00" with no legend.
// 0.67 of what? The number is the proof, the word is the answer: High is worth
// acting on now, Medium cleared the bar for being proposed at all, Low did not.

import Foundation

public enum PracticeScoreBand: Equatable, Sendable {
    case high, medium, low

    /// `proposalBar` is the project's own `thresholds.minValue` (0.6 by default).
    public static func band(_ value: Double, proposalBar: Double = 0.6) -> PracticeScoreBand {
        if value < proposalBar { return .low }
        return value >= proposalBar + 0.2 ? .high : .medium
    }

    public var label: String {
        switch self {
        case .high: return "High"
        case .medium: return "Medium"
        case .low: return "Low"
        }
    }

    public static func summary(_ value: Double, proposalBar: Double = 0.6) -> String {
        "\(band(value, proposalBar: proposalBar).label) · \(String(format: "%.2f", value))"
    }

    /// Shown as the tooltip on the Findings group and in a finding's detail,
    /// after the word "Priority".
    public static let legend =
        "How much a finding is worth acting on, on a scale of 0 to 1. It combines how often it recurs, what it cost, how reliably it was seen and how fixable it is, minus decay. 0.60 or more is proposed; 0.80 or more is High."
}
