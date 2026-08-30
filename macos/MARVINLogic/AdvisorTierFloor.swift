// AdvisorTierFloor — warn when the second opinion is weaker than the executor.
//
// The advisor subagent (ADR-0033) defaults to the latest Opus tier because
// "a second opinion should always come from the strongest model, even when a
// cheaper model drives the loop". The Settings model picker, though, lets both
// sides be chosen freely — so an advisor can be set BELOW the executor, which
// inverts the point of consulting one: the reviewer is then less capable than
// the author it is reviewing.
//
// Deliberately a soft floor (user, 2026-08-30). There are legitimate reasons
// to run a cheap advisor — cost, latency, or wanting a deliberately different
// perspective — so this warns and gets out of the way. It never blocks Apply.
//
// Pure (ADR-0022) so the ranking is test-pinned rather than re-derived in a
// SwiftUI body.

import Foundation

public enum AdvisorTierFloor {
    /// Capability ranking of the coarse tiers `/api/models` reports.
    ///
    /// Only the Claude tiers are here, and deliberately so: `tierFor()` in
    /// `models.ts` derives the tier by substring, so every non-Anthropic model
    /// on OpenRouter (`openai/gpt-5`, `google/gemini-2.5-pro`) lands in
    /// `other`. There is no honest cross-vendor capability ordering to hardcode
    /// — that is what `priceWarning` exists for.
    private static let rank: [String: Int] = [
        "haiku": 0,
        "sonnet": 1,
        "opus": 2,
    ]

    /// How much cheaper the advisor must be before price is treated as signal.
    ///
    /// Price is a market proxy for capability, not a measurement, so a small
    /// gap means nothing — two models within a factor of two are simply
    /// priced differently. At less than half the executor's output price the
    /// gap is deliberate market positioning, which is worth a word.
    public static let priceRatioFloor = 0.5

    /// The warning to show, or nil when there is nothing to say.
    ///
    /// Tier first — it is exact for the Claude family. Price second, for the
    /// third-party and OpenRouter models that have no tier. Returns nil when
    /// either side is unset (an unset advisor resolves to the latest Opus, an
    /// unset executor to the runtime default, so neither is a choice made
    /// here) or when neither signal is available on both sides.
    public static func warning(
        executorTier: String?,
        advisorTier: String?,
        executorPrice: Double? = nil,
        advisorPrice: Double? = nil
    ) -> String? {
        if let tierWarning = tierWarning(executorTier: executorTier, advisorTier: advisorTier) {
            return tierWarning
        }
        return priceWarning(
            executorTier: executorTier,
            advisorTier: advisorTier,
            executorPrice: executorPrice,
            advisorPrice: advisorPrice
        )
    }

    /// Exact comparison, Claude tiers only.
    private static func tierWarning(executorTier: String?, advisorTier: String?) -> String? {
        guard let executorTier, let advisorTier else { return nil }
        guard
            let executor = rank[executorTier.lowercased()],
            let advisor = rank[advisorTier.lowercased()],
            advisor < executor
        else { return nil }
        return "The advisor (\(advisorTier.lowercased())) is weaker than the executor "
            + "(\(executorTier.lowercased())). A second opinion is meant to come from the "
            + "stronger model — this one will be reviewing work it could not have produced. "
            + "Fine if it's deliberate (cost, latency, a different perspective); otherwise "
            + "raise the advisor."
    }

    /// Fallback for models with no tier — the OpenRouter catalogue.
    ///
    /// Only fires when at least one side is untiered: two models that BOTH
    /// carry a Claude tier were already judged exactly above, and a cheap Opus
    /// is still an Opus.
    private static func priceWarning(
        executorTier: String?,
        advisorTier: String?,
        executorPrice: Double?,
        advisorPrice: Double?
    ) -> String? {
        let bothTiered =
            rank[(executorTier ?? "").lowercased()] != nil && rank[(advisorTier ?? "").lowercased()] != nil
        if bothTiered { return nil }
        guard
            let executorPrice, let advisorPrice,
            executorPrice > 0, advisorPrice > 0,
            advisorPrice < executorPrice * priceRatioFloor
        else { return nil }
        let factor = executorPrice / advisorPrice
        // Price, not capability — say which one this is. Claiming a vendor
        // ranking MARVIN cannot justify would be worse than saying nothing.
        return String(
            format: "The advisor costs about %.0f× less per output token than the executor. "
                + "Price isn't capability, but across a marketplace it usually tracks it — and a "
                + "second opinion is meant to come from the stronger model. Fine if it's "
                + "deliberate; otherwise check the advisor is not the weaker model.",
            factor
        )
    }
}
