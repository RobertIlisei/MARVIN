// SupervisorNewTabEdit — what the new-tab card's "Edit…" sheet may offer.
//
// ADR-0128 §5: the first message and the title change freely; the posture may
// only narrow and the delegation only lower. The server refuses anything
// else with `widening` (supervisor-inbox-actions.ts, `case "new-tab"`), so each
// picker offers only what the server would accept — the orders here mirror
// `posture.ts` (STRATEGY_ORDER, MODE_ORDER, EFFORT_ORDER, modelDirection) and
// `NEW_TAB_DELEGATIONS`. Where the server's verdict depends on something the
// card does not show (Plan ↔ Ask is judged by the advisor model's price), or
// the proposed value is unknown, only the proposed value is offered.

import CoreGraphics
import Foundation

public enum SupervisorNewTabEdit {
    /// Narrowest first, as in posture.ts.
    public static let strategyOrder = ["gated", "auto", "full"]
    public static let effortOrder = ["low", "medium", "high", "xhigh", "max"]
    /// Widest first, as NEW_TAB_DELEGATIONS.
    public static let delegationOrder = ["answer-questions", "observe", "off"]
    static let tierOrder = ["haiku", "sonnet", "opus"]

    /// A model as the active catalogue (`/api/models`) describes it.
    public struct CatalogModel: Equatable, Sendable, Identifiable {
        public let id: String
        public let displayName: String
        public let tier: String
        /// Per-input-token price (`pricing.prompt`) — what the server compares.
        public let promptPrice: Double?
        public init(id: String, displayName: String, tier: String, promptPrice: Double? = nil) {
            self.id = id; self.displayName = displayName; self.tier = tier; self.promptPrice = promptPrice
        }
    }

    /// The editable fields, as proposed or as chosen. `effort` / `strategy` / `model` are "" when the card did not say.
    public struct Fields: Equatable, Sendable {
        public var firstMessage: String
        public var title: String
        public var delegation: String
        public var strategy: String
        public var mode: String
        public var model: String
        public var effort: String
        public init(firstMessage: String, title: String, delegation: String, strategy: String,
                    mode: String, model: String, effort: String) {
            self.firstMessage = firstMessage; self.title = title; self.delegation = delegation
            self.strategy = strategy; self.mode = mode; self.model = model; self.effort = effort
        }

        public init(_ item: SupervisorInboxItem) {
            let p = item.newTab?.posture
            self.init(firstMessage: item.newTab?.firstMessage ?? "",
                      title: SupervisorNewTabEdit.proposedTitle(item) ?? "",
                      // The server's default when the card carries none (act.delegation ?? "off").
                      delegation: item.newTab?.delegation ?? "off",
                      strategy: p?.strategy ?? "", mode: p?.mode ?? "agent",
                      model: p?.model ?? "", effort: p?.effort ?? "")
        }
    }

    // MARK: - Choices: the proposed value first, then each narrower one

    public static func strategies(proposed: String) -> [String] {
        narrowerOrSame(strategyOrder, proposed)
    }

    /// Agent → Plan or Ask narrows. Plan ↔ Ask is judged by the advisor model's
    /// cost, which the card does not carry, so neither is offered from the other.
    public static func modes(proposed: String) -> [String] {
        proposed == "agent" ? ["agent", "plan", "ask"] : [proposed]
    }

    public static func efforts(proposed: String) -> [String] {
        narrowerOrSame(effortOrder, proposed)
    }

    public static func delegations(proposed: String) -> [String] {
        guard let i = delegationOrder.firstIndex(of: proposed) else { return [proposed] }
        return Array(delegationOrder[i...])
    }

    /// The proposed model, then every catalogue model the server would call no
    /// wider: both priced → no pricier; both unpriced → no higher tier; else wider.
    public static func models(proposed: String, catalog: [CatalogModel]) -> [CatalogModel] {
        let from = catalog.first { $0.id == proposed }
        let head = from ?? CatalogModel(id: proposed, displayName: proposed, tier: "other")
        guard let from else { return [head] }
        let narrower = catalog.filter { $0.id != proposed && isNoWider(from: from, to: $0) }
        return [head] + narrower
    }

    static func isNoWider(from a: CatalogModel, to b: CatalogModel) -> Bool {
        if let pa = a.promptPrice, let pb = b.promptPrice { return pb <= pa }
        guard a.promptPrice == nil, b.promptPrice == nil,
              let ta = tierOrder.firstIndex(of: a.tier), let tb = tierOrder.firstIndex(of: b.tier) else { return false }
        return tb <= ta
    }

    private static func narrowerOrSame(_ narrowestFirst: [String], _ proposed: String) -> [String] {
        guard let i = narrowestFirst.firstIndex(of: proposed) else { return proposed.isEmpty ? [] : [proposed] }
        return Array(narrowestFirst[...i].reversed())
    }

    // MARK: - What the card proposed that the wire carries elsewhere

    /// The title rides in the server-built raw act's input (`new_session`), not in `newTab`.
    public static func proposedTitle(_ item: SupervisorInboxItem) -> String? {
        guard case .object(let o)? = item.rawAct?.input, case .string(let t)? = o["title"] else { return nil }
        let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - The edits the server reads

    /// `edits` for the `edit` action: the first message always (an edit must
    /// change something, and it is what the user read), every other field only
    /// when it differs, posture under the server's patch keys.
    public static func edits(proposed: Fields, chosen: Fields) -> [String: Any] {
        var out: [String: Any] = ["firstMessage": chosen.firstMessage.trimmingCharacters(in: .whitespacesAndNewlines)]
        let title = chosen.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if title != proposed.title { out["title"] = title }
        if chosen.delegation != proposed.delegation { out["delegation"] = chosen.delegation }
        var posture: [String: Any] = [:]
        if chosen.strategy != proposed.strategy, !chosen.strategy.isEmpty { posture["permissionStrategy"] = chosen.strategy }
        if chosen.mode != proposed.mode { posture["mode"] = chosen.mode }
        if chosen.model != proposed.model, !chosen.model.isEmpty { posture["model"] = chosen.model }
        if chosen.effort != proposed.effort, !chosen.effort.isEmpty { posture["thinkingMode"] = chosen.effort }
        if !posture.isEmpty { out["posture"] = posture }
        return out
    }

    // MARK: - Sheet size

    public static let minSize = CGSize(width: 520, height: 460)
    /// Room left around the sheet so it never covers the whole window.
    static let windowMargin: CGFloat = 40

    /// 70 % of the window on first open, the user's last size after that —
    /// clamped to the minimum and to the window it hangs from.
    public static func sheetSize(window: CGSize?, remembered: CGSize?) -> CGSize {
        let win = window ?? CGSize(width: 1280, height: 860)
        let maxW = max(minSize.width, win.width - windowMargin)
        let maxH = max(minSize.height, win.height - windowMargin)
        let want = remembered.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
            ?? CGSize(width: (win.width * 0.7).rounded(), height: (win.height * 0.7).rounded())
        return CGSize(width: min(max(want.width, minSize.width), maxW),
                      height: min(max(want.height, minSize.height), maxH))
    }
}
