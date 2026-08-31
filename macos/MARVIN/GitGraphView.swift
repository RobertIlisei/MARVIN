// GitGraphView — the commit graph in the Source Control panel.
//
// The reference (Antigravity's "Git Graph" panel, and VS Code's newer
// SCM graph) draws a real DAG: one coloured rail per concurrent line
// of development, dots on the rail for each commit, and curves where
// branches fork and merge. MARVIN's previous history surface was a
// straight vertical line with dots on it, which cannot show what the
// user actually looks at a graph for — where a branch came off and
// where it went back in.
//
// ## Lane assignment
//
// One pass over `git log --topo-order --all`, newest first, keeping an
// array of open lanes. Each slot holds the sha that lane is *waiting
// for*:
//
//   1. The commit takes the leftmost lane already waiting for its sha.
//      If nothing waits for it, it is a tip — allocate a free lane.
//   2. Any OTHER lane also waiting for this sha is a branch merging
//      in; record it as an incoming edge and close it.
//   3. The commit's first parent inherits its lane (a line of
//      development continues straight down). Extra parents — a merge
//      commit has two or more — each get a lane of their own, which is
//      what draws the fork on the row below.
//
// Because the walk is topological, a lane's sha is always resolved
// before anything below it needs it, so no lookahead is required.
//
// The layout is pure and `Sendable`, which keeps it testable and off
// the view: `GitGraphLayout.build(commits)` in, rows out.

import SwiftUI

/// One rendered row: the commit plus everything needed to draw its
/// rails without consulting neighbours.
struct GitGraphRow: Identifiable, Equatable {
    let commit: GitGraphCommit
    /// Lane this commit's dot sits on.
    let lane: Int
    /// Lanes occupied ABOVE this row (drawn as line segments from the
    /// row's top edge to its centre).
    let lanesAbove: [Int]
    /// Lanes occupied BELOW this row (centre to bottom edge).
    let lanesBelow: [Int]
    /// Lanes that merge INTO this commit — drawn as a curve from the
    /// top edge at that lane to the dot.
    let incoming: [Int]
    /// Lanes this commit's extra parents open — drawn as a curve from
    /// the dot to the bottom edge at that lane.
    let outgoing: [Int]
    /// Colour index for the commit's own lane.
    var colorIndex: Int { lane }

    var id: String { commit.sha }
}

enum GitGraphLayout {
    /// Assign lanes to a topologically-ordered, newest-first commit
    /// list. Never returns more rows than it was given.
    static func build(_ commits: [GitGraphCommit]) -> [GitGraphRow] {
        // `lanes[i]` = the sha lane `i` is waiting for; nil = free.
        var lanes: [String?] = []
        var rows: [GitGraphRow] = []

        for commit in commits {
            let above = occupied(lanes)

            // 1. Which lane is this commit on?
            var lane = lanes.firstIndex { $0 == commit.sha } ?? -1
            if lane < 0 {
                lane = allocate(&lanes, for: commit.sha)
            }

            // 2. Other lanes waiting for the same sha are branches
            //    landing on this commit. Close them.
            var incoming: [Int] = []
            for (i, waiting) in lanes.enumerated()
            where i != lane && waiting == commit.sha {
                incoming.append(i)
                lanes[i] = nil
            }

            // 3. Hand the lane to the first parent; give every extra
            //    parent a lane of its own.
            var outgoing: [Int] = []
            if let first = commit.parents.first {
                lanes[lane] = first
            } else {
                // Root commit — the line ends here.
                lanes[lane] = nil
            }
            for parent in commit.parents.dropFirst() {
                // A parent already being waited for needs no new lane;
                // the existing one will collect it.
                if let existing = lanes.firstIndex(of: parent) {
                    outgoing.append(existing)
                } else {
                    outgoing.append(allocate(&lanes, for: parent))
                }
            }

            trimTrailingFree(&lanes)

            rows.append(
                GitGraphRow(
                    commit: commit,
                    lane: lane,
                    lanesAbove: above,
                    lanesBelow: occupied(lanes),
                    incoming: incoming,
                    outgoing: outgoing
                )
            )
        }
        return rows
    }

    /// Leftmost free slot, or a new one on the right.
    private static func allocate(_ lanes: inout [String?], for sha: String) -> Int {
        if let free = lanes.firstIndex(where: { $0 == nil }) {
            lanes[free] = sha
            return free
        }
        lanes.append(sha)
        return lanes.count - 1
    }

    private static func occupied(_ lanes: [String?]) -> [Int] {
        lanes.enumerated().compactMap { $1 == nil ? nil : $0 }
    }

    /// Keeps the lane array from growing forever on a long history —
    /// without this the rendered width would only ever increase.
    private static func trimTrailingFree(_ lanes: inout [String?]) {
        while let last = lanes.last, last == nil { lanes.removeLast() }
    }
}

/// Rail colours, cycled by lane index. Distinct hues at low
/// saturation so eight concurrent branches stay separable without the
/// panel turning into a fruit salad.
enum GitGraphPalette {
    static let colors: [Color] = [
        Color(red: 0.91, green: 0.63, blue: 0.30),  // amber
        Color(red: 0.45, green: 0.70, blue: 0.90),  // blue
        Color(red: 0.62, green: 0.55, blue: 0.88),  // violet
        Color(red: 0.45, green: 0.80, blue: 0.62),  // teal
        Color(red: 0.88, green: 0.52, blue: 0.66),  // pink
        Color(red: 0.80, green: 0.78, blue: 0.42),  // olive
        Color(red: 0.55, green: 0.78, blue: 0.45),  // green
        Color(red: 0.85, green: 0.47, blue: 0.40),  // rust
    ]

    static func color(_ lane: Int) -> Color {
        colors[abs(lane) % colors.count]
    }
}

// MARK: - View

@MainActor
@Observable
final class GitGraphModel {
    private(set) var rows: [GitGraphRow] = []
    private(set) var isLoading = false
    private(set) var loadError: String? = nil
    private(set) var loadedCwd: String? = nil

    private var task: Task<Void, Never>?

    func refresh(cwd: String, limit: Int = 120, force: Bool = false) {
        if !force, loadedCwd == cwd, !rows.isEmpty, !isLoading { return }
        task?.cancel()
        isLoading = true
        loadError = nil
        task = Task { @MainActor in
            defer { isLoading = false }
            do {
                let res = try await FilesService.shared.fetchGraph(
                    cwd: cwd, limit: limit
                )
                guard !Task.isCancelled else { return }
                let commits = res.commits ?? []
                // Lane assignment over 120 commits is cheap, but it is
                // still pure CPU on the main actor for no reason.
                rows = await Task.detached(priority: .userInitiated) {
                    GitGraphLayout.build(commits)
                }.value
                loadedCwd = cwd
            } catch is CancellationError {
                /* project switch raced us */
            } catch {
                loadError = "\(error)"
            }
        }
    }

    func clear() {
        task?.cancel()
        rows = []
        loadedCwd = nil
        loadError = nil
    }
}

/// The scrollable graph list. Hosted by `SourceControlView` as its
/// bottom section; sized by the caller.
struct GitGraphView: View {
    let cwd: String
    var model: GitGraphModel

    private static let rowHeight: CGFloat = 24
    private static let laneWidth: CGFloat = 13
    private static let dotRadius: CGFloat = 3.5

    var body: some View {
        Group {
            if let err = model.loadError {
                message("graph error: \(err)")
            } else if model.rows.isEmpty {
                message(model.isLoading ? "Loading graph…" : "(no commits yet)")
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(model.rows) { row in
                            GitGraphRowView(
                                row: row,
                                laneCount: laneCount,
                                rowHeight: Self.rowHeight,
                                laneWidth: Self.laneWidth,
                                dotRadius: Self.dotRadius
                            )
                        }
                    }
                }
            }
        }
    }

    /// Widest row wins, capped at eight: past that the rail strip
    /// crowds out the subject text, which is the part people read.
    ///
    /// Overflow is a real state, not a theoretical one — 300 commits of
    /// this repo's own history reach lane 8. Rails beyond the cap are
    /// not drawn and the dot CLAMPS to the last rail rather than
    /// disappearing: a slightly misplaced dot still says "a commit is
    /// here", a missing one silently drops a row from the graph.
    private var laneCount: Int {
        let widest = model.rows.reduce(1) { acc, row in
            max(acc, (row.lanesAbove + row.lanesBelow + [row.lane]).max().map { $0 + 1 } ?? 1)
        }
        return min(widest, 8)
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
    }
}

private struct GitGraphRowView: View {
    let row: GitGraphRow
    let laneCount: Int
    let rowHeight: CGFloat
    let laneWidth: CGFloat
    let dotRadius: CGFloat

    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            rails
            content
        }
        .frame(height: rowHeight)
        .padding(.horizontal, 8)
        .background(hovering ? MarvinTheme.rowHover : Color.clear)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .help("\(row.commit.shortSha) · \(row.commit.author) · \(row.commit.relativeDate)")
        .contextMenu {
            Button("Copy SHA") { copy(row.commit.sha) }
            Button("Copy Subject") { copy(row.commit.subject) }
        }
    }

    /// The lane strip. One `Canvas` for the whole row rather than a
    /// stack of shapes — the merge curves cross lane boundaries, so
    /// there is no per-lane view that could own them.
    private var rails: some View {
        Canvas { ctx, size in
            let mid = size.height / 2
            func x(_ lane: Int) -> CGFloat {
                laneWidth * (CGFloat(lane) + 0.5)
            }

            // Straight segments for every lane passing through.
            for lane in row.lanesAbove where lane < laneCount {
                var path = Path()
                path.move(to: CGPoint(x: x(lane), y: 0))
                path.addLine(to: CGPoint(x: x(lane), y: mid))
                ctx.stroke(path, with: .color(GitGraphPalette.color(lane)), lineWidth: 1.5)
            }
            for lane in row.lanesBelow where lane < laneCount {
                var path = Path()
                path.move(to: CGPoint(x: x(lane), y: mid))
                path.addLine(to: CGPoint(x: x(lane), y: size.height))
                ctx.stroke(path, with: .color(GitGraphPalette.color(lane)), lineWidth: 1.5)
            }

            // Branches merging in: curve from the top edge to the dot.
            for lane in row.incoming where lane < laneCount {
                var path = Path()
                path.move(to: CGPoint(x: x(lane), y: 0))
                path.addQuadCurve(
                    to: CGPoint(x: x(row.lane), y: mid),
                    control: CGPoint(x: x(lane), y: mid)
                )
                ctx.stroke(path, with: .color(GitGraphPalette.color(lane)), lineWidth: 1.5)
            }

            // Extra parents: curve from the dot down into their lane.
            for lane in row.outgoing where lane < laneCount && lane != row.lane {
                var path = Path()
                path.move(to: CGPoint(x: x(row.lane), y: mid))
                path.addQuadCurve(
                    to: CGPoint(x: x(lane), y: size.height),
                    control: CGPoint(x: x(lane), y: mid)
                )
                ctx.stroke(path, with: .color(GitGraphPalette.color(lane)), lineWidth: 1.5)
            }

            // The commit dot. A merge is drawn hollow so the two
            // shapes are distinguishable at a glance without colour.
            let centre = CGPoint(x: x(min(row.lane, laneCount - 1)), y: mid)
            let rect = CGRect(
                x: centre.x - dotRadius,
                y: centre.y - dotRadius,
                width: dotRadius * 2,
                height: dotRadius * 2
            )
            let colour = GitGraphPalette.color(row.lane)
            if row.commit.parents.count > 1 {
                ctx.stroke(Path(ellipseIn: rect), with: .color(colour), lineWidth: 1.8)
            } else {
                ctx.fill(Path(ellipseIn: rect), with: .color(colour))
            }
        }
        .frame(width: laneWidth * CGFloat(laneCount))
    }

    private var content: some View {
        HStack(spacing: 6) {
            ForEach(row.commit.refs.prefix(3), id: \.self) { ref in
                refChip(ref)
            }
            Text(row.commit.subject)
                .font(.system(size: 11))
                .foregroundStyle(MarvinTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
            Text(hovering ? row.commit.shortSha : row.commit.author)
                .font(.system(size: 10).monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
    }

    /// `HEAD`, a branch, a remote branch and a tag each read
    /// differently and the reference colours them apart, so we do too.
    private func refChip(_ ref: String) -> some View {
        let isTag = ref.hasPrefix("tag: ")
        let name = isTag ? String(ref.dropFirst("tag: ".count)) : ref
        let isHead = name == "HEAD"
        let isRemote = name.contains("/") && !isTag
        let tint: Color =
            isTag ? GitDecorationColor.modified
            : isHead ? Color.accentColor
            : isRemote ? GitGraphPalette.color(1)
            : GitDecorationColor.added
        return HStack(spacing: 3) {
            Image(systemName: isTag ? "tag.fill" : (isRemote ? "cloud.fill" : "arrow.triangle.branch"))
                .font(.system(size: 7))
            Text(name)
                .font(.system(size: 9.5, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(
            Capsule().fill(tint.opacity(0.14))
        )
        .frame(maxWidth: 160, alignment: .leading)
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
