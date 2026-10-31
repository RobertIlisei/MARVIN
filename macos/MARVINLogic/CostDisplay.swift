// CostDisplay — what the cost popover says about money and plan windows.
//
// Pure, so it can be asserted (MARVINTests "cost-display"). The sidecar
// decides what a window is called and whether it is still in the server's
// latest report; this side only applies the one rule that depends on the
// clock while a popover stays open: a window whose refill time has passed,
// with no report since, describes a period that is over.

import Foundation

public enum PlanWindowClock {
    public static func isExpired(resetsAt: Double?, lastReportedAt: Date?, now: Date) -> Bool {
        guard let resetsAt else { return false }
        let reset = Date(timeIntervalSince1970: resetsAt)
        guard reset <= now else { return false }
        guard let lastReportedAt else { return true }
        return lastReportedAt < reset
    }

    public static func lastReported(_ at: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(at))
        if s < 60 { return "last reported just now" }
        if s < 3600 { return "last reported \(Int(s / 60))m ago" }
        if s < 86_400 { return "last reported \(Int(s / 3600))h ago" }
        return "last reported \(Int(s / 86_400))d ago"
    }

    /// The sidecar's ISO timestamps, with or without fractional seconds.
    public static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

/// How one auth mode's dollars read. The modes are never summed into one
/// unlabelled figure: a plan's API-equivalent gauge, an API bill and an
/// OpenRouter estimate are three different things.
public struct CostModeDisplay: Equatable {
    public let key: String
    /// The SDK's `subscriptionType`, as given ("ultra", "max", …). Plans get
    /// renamed — Max 20x became Ultra — so it is title-cased, never mapped.
    public let plan: String?

    public init(key: String, plan: String? = nil) {
        self.key = key
        self.plan = plan
    }

    public var title: String {
        switch key {
        case "subscription":
            if let plan, !plan.trimmingCharacters(in: .whitespaces).isEmpty {
                return "Claude plan · " + plan.split(whereSeparator: { $0 == "_" || $0 == "-" || $0 == " " })
                    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
                    .joined(separator: " ")
            }
            return "Claude plan · API-equivalent"
        case "anthropic-api": return "Anthropic API · billed"
        case "openrouter": return "OpenRouter · estimate"
        case "gateway": return "Gateway · estimate"
        case "cloud-provider": return "Cloud provider · estimate"
        case "other": return "other credentials · estimate"
        case "unknown": return "mode not recorded"
        default: return key
        }
    }

    /// One line under the title saying what the figure is and is not.
    public var caption: String {
        switch key {
        case "subscription": return "What the tokens would cost at API rates — a gauge, not a bill. The plan windows below are your real limit."
        case "anthropic-api": return "What Anthropic bills this key, as reported by Claude Code."
        case "openrouter": return "Priced from OpenRouter's model list — may not match OpenRouter's billing. OpenRouter's own figures are below."
        case "gateway": return "Claude Code runs through an enterprise gateway; billing is the gateway's. Claude Code's rate-card figure."
        case "cloud-provider": return "Billed by your cloud account (Bedrock, Vertex, …). Claude Code's rate-card figure."
        case "unknown": return "Recorded before the auth mode was."
        default: return "Claude Code's figure — not confirmed by a bill."
        }
    }

    public var isBill: Bool { key == "anthropic-api" }

    /// `≈` for a gauge, `~` for an estimate, nothing for a bill.
    public func chip(_ usd: Double) -> String {
        let figure = CostModeDisplay.usd(usd)
        switch key {
        case "anthropic-api": return figure
        case "subscription": return "≈" + figure
        default: return "~" + figure
        }
    }

    public static func usd(_ v: Double) -> String {
        if v > 0 && v < 0.01 { return String(format: "$%.4f", v) }
        return String(format: "$%.2f", v)
    }
}

public struct TokenBreakdown: Equatable {
    public let uncached: Int
    public let cacheRead: Int
    public let cacheWrite: Int
    public let output: Int

    public init(uncached: Int, cacheRead: Int, cacheWrite: Int, output: Int) {
        self.uncached = uncached
        self.cacheRead = cacheRead
        self.cacheWrite = cacheWrite
        self.output = output
    }

    /// Every input token the model read: new, from cache, and written to cache.
    public var totalInput: Int { uncached + cacheRead + cacheWrite }

    public var inputParts: String {
        "\(TokenBreakdown.compact(uncached)) new · \(TokenBreakdown.compact(cacheRead)) cache read · \(TokenBreakdown.compact(cacheWrite)) cache write"
    }

    public static func compact(_ n: Int) -> String {
        let d = Double(n)
        if n >= 1_000_000 { return String(format: "%.2fM", d / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", d / 1_000) }
        return String(n)
    }
}
