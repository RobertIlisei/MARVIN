// PaneBandPlan — who gets the height of a pane's lower band (pane-standard.md 2.12).
//
// The owner, 25.11: "the history seems to be cut if the other menu is minimised."
// Source Control drew its commit graph at a fixed 200 pt; with a clean tree and
// Stashes folded, 500 pt of grey sat under a graph cut mid-row. A fixed height on
// a region that scrolls is wrong in both directions: it cuts content while space
// is free, and leaves space while content is cut.
//
// The rule, as a function: a section takes what it needs (`natural`), but never
// less than `minimum` while the pane can afford it; when the sections want more
// than the pane has, the surplus is shared by `weight` and each is capped at what
// it wants; when they want less, the LAST open section that `grows` takes the
// rest, so nothing is left empty under it. A folded section takes its header
// (`chrome`) and nothing else. Pure, in points, no SwiftUI: the view measures the
// band with `onGeometryChange` and feeds it here.

import Foundation

public struct PaneBandSection: Equatable {
    public var id: String
    /// What the section always draws: its divider and header. A folded section is only this.
    public var chrome: Double
    public var isOpen: Bool
    /// The height of the body if nothing limited it: rows × row height.
    public var natural: Double
    /// What the body keeps when the pane is short (a usable few rows).
    public var minimum: Double
    /// Share of the contested height; a list that scrolls long is weighted above a graph.
    public var weight: Double
    /// May the body be taller than its content? The list and the graph can (they scroll
    /// and have a background); a preview of a three-line diff cannot.
    public var grows: Bool

    public init(id: String, chrome: Double, isOpen: Bool, natural: Double, minimum: Double,
                weight: Double = 1, grows: Bool = true) {
        self.id = id
        self.chrome = chrome
        self.isOpen = isOpen
        self.natural = natural
        self.minimum = minimum
        self.weight = weight
        self.grows = grows
    }
}

public enum PaneBandPlan {
    /// The body height of every section, by id. A folded section is 0.
    /// `available` is the whole band, headers included.
    public static func contentHeights(available: Double, sections: [PaneBandSection]) -> [String: Double] {
        var heights: [String: Double] = [:]
        for s in sections { heights[s.id] = 0 }
        let budget = available - sections.reduce(0) { $0 + $1.chrome }
        let open = sections.filter { $0.isOpen }
        guard budget > 0, !open.isEmpty else { return heights }

        // 1. Everyone's floor.
        var base: [String: Double] = [:]
        for s in open { base[s.id] = max(0, min(s.minimum, s.natural)) }
        let floors = base.values.reduce(0, +)
        if floors > budget {
            // Less room than the floors: shrink them together rather than overflow.
            for s in open { heights[s.id] = (base[s.id] ?? 0) * budget / floors }
            return heights
        }
        for s in open { heights[s.id] = base[s.id] ?? 0 }
        var leftover = budget - floors

        // 2. Share the rest by weight, each capped at what it wants (water-filling).
        var wanting = open.filter { max(0, $0.natural - (base[$0.id] ?? 0)) > 0 }
        while leftover > 0.0001, !wanting.isEmpty {
            let totalWeight = wanting.reduce(0) { $0 + max($1.weight, 0.0001) }
            let satisfied = wanting.filter { s in
                let want = s.natural - (heights[s.id] ?? 0)
                return want <= leftover * max(s.weight, 0.0001) / totalWeight
            }
            if satisfied.isEmpty {
                for s in wanting { heights[s.id, default: 0] += leftover * max(s.weight, 0.0001) / totalWeight }
                leftover = 0
            } else {
                for s in satisfied {
                    let want = s.natural - (heights[s.id] ?? 0)
                    heights[s.id, default: 0] += want
                    leftover -= want
                }
                wanting.removeAll { w in satisfied.contains { $0.id == w.id } }
            }
        }

        // 3. Whatever is left belongs to the last open section that can grow.
        if leftover > 0.0001, let filler = open.last(where: { $0.grows }) {
            heights[filler.id, default: 0] += leftover
        }
        return heights
    }
}
