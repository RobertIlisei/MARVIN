// SlashCommandPopup — `/`-triggered command autocomplete for the composer.
//
// MARVIN always FORWARDED slash commands correctly (the chat input passes the
// raw message to the SDK, which parses `/foo` itself), but the composer offered
// no autocomplete, no descriptions, and no validation. So a command only worked
// if you already knew its exact name, and a typo silently became a normal chat
// message. Claude Code's terminal shows a filtered list with descriptions; this
// is that, natively.
//
// Data comes from `GET /api/commands`, which serves the catalog captured from
// the SDK's `supportedCommands()` during turns — the only source carrying
// descriptions + argument hints (the system/init event has bare names).
//
// Keyboard contract (see ChatNSTextView): ↑/↓ move, ⇥ or ⏎ accept, ⎋ dismiss —
// and ALL of it is gated on the popup being open, so normal typing is
// untouched when it isn't.

import SwiftUI

struct SlashCommand: Decodable, Identifiable, Equatable {
    let name: String
    let description: String
    let argumentHint: String
    var id: String { name }
}

/// Composer-side state machine for the popup. Kept separate from the view so
/// the trigger rules are readable in one place.
/// `@MainActor` is load-bearing: `generation` is bumped per keystroke and read
/// again after an `await`. Mutating it from a non-isolated `Task` while reading
/// it inside `MainActor.run` is a data race that can make every response look
/// stale and get dropped — leaving the popup frozen on an early result set
/// while the query indicator kept updating.
@MainActor
@Observable
final class SlashCommandModel {
    private(set) var matches: [SlashCommand] = []
    /// The query the popup is CURRENTLY filtered on. Surfaced in the footer so
    /// a stale popup is visibly stale instead of silently wrong.
    private(set) var activeQuery: String = ""
    private(set) var selected: Int = 0
    /// Full catalog, fetched once per project and filtered locally so
    /// keystrokes don't each cost a round-trip.
    private var catalog: [SlashCommand] = []
    private var loadedProjectId: String?

    var isOpen: Bool { !matches.isEmpty }

    /// Every known command name — drives the composer's token highlighting,
    /// which is what makes a real `/command` visually distinct from text that
    /// merely starts with a slash. Independent of the popup being open, so a
    /// completed `/cmd args` stays highlighted.
    var knownNames: Set<String> { Set(catalog.map(\.name)) }

    /// The query is the text after a LEADING `/` with no space yet — i.e. the
    /// popup is only live while the user is still typing the command token.
    /// Returns nil when the text isn't a command-in-progress, which is what
    /// closes the popup for ordinary messages, for `/cmd <args>`, and for a
    /// `/` that isn't at the start.
    static func query(from text: String) -> String? {
        guard text.hasPrefix("/") else { return nil }
        let rest = text.dropFirst()
        if rest.contains(" ") || rest.contains("\n") { return nil }
        return String(rest)
    }

    /// Project scope for queries. Set once; queries carry it.
    private var projectId: String?
    private var workDir: String?
    /// Generation counter so an older in-flight response can't overwrite a
    /// newer one (keystrokes race on a shared connection).
    private var generation: Int = 0

    func load(projectId: String, workDir: String?) async {
        self.projectId = projectId
        self.workDir = workDir
        // Prime `knownNames` (used for composer highlighting) with the full
        // catalog. Filtering itself is done server-side per keystroke.
        await search(query: nil, prime: true)
    }

    /// Re-evaluate against the composer text. Called on every keystroke.
    func update(for text: String) {
        guard let q = Self.query(from: text) else {
            close()
            return
        }
        activeQuery = q
        Task { await search(query: q, prime: false) }
    }

    /// Ask the server to rank. The ranking lives in ONE place —
    /// `filterCommands`/`rankCommand` in `slash-commands.ts` — instead of being
    /// duplicated here, which is how the client and server ended up disagreeing
    /// (server correctly returned `improve-animations` for "improve" while this
    /// class returned the first four commands alphabetically).
    private func search(query: String?, prime: Bool) async {
        guard let projectId else { return }
        generation += 1
        let gen = generation
        var comps = URLComponents(
            url: ServerConfig.baseURL.appendingPathComponent("api/commands"),
            resolvingAgainstBaseURL: false
        )!
        var items = [URLQueryItem(name: "projectId", value: projectId)]
        if let workDir, !workDir.isEmpty {
            items.append(URLQueryItem(name: "workDir", value: workDir))
        }
        if let query, !query.isEmpty {
            items.append(URLQueryItem(name: "q", value: query))
        }
        comps.queryItems = items
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        struct Response: Decodable { let commands: [SlashCommand] }
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            let parsed = try JSONDecoder().decode(Response.self, from: data)
            // Class is @MainActor, so this resumes on the main actor and the
            // generation check is race-free.
            guard gen == generation else { return }
            if prime {
                catalog = parsed.commands
            } else {
                matches = parsed.commands
                if selected >= matches.count { selected = 0 }
            }
        } catch {
            // Autocomplete is an affordance — a failed lookup must never
            // interrupt composing.
        }
    }

    // NOTE: local ranking deliberately REMOVED. It duplicated
    // `rankCommand`/`filterCommands` in `slash-commands.ts` and the two
    // diverged in production — the server correctly ranked "improve" →
    // improve-animations while this copy returned the first four commands
    // alphabetically. One ranking implementation, server-side, verified by its
    // own unit tests.

    /// Set the highlight directly (mouse click on a row).
    func selectIndex(_ idx: Int) {
        guard matches.indices.contains(idx) else { return }
        selected = idx
    }

    func move(_ delta: Int) {
        guard !matches.isEmpty else { return }
        // Wraps, matching the terminal's behaviour.
        selected = (selected + delta + matches.count) % matches.count
    }

    func close() {
        matches = []
        selected = 0
        activeQuery = ""
    }

    /// The text the composer should hold after accepting the highlighted
    /// command — a trailing space so the user types arguments immediately.
    func accepted() -> String? {
        guard matches.indices.contains(selected) else { return nil }
        return "/\(matches[selected].name) "
    }
}

struct SlashCommandPopup: View {
    let matches: [SlashCommand]
    let selected: Int
    /// Adaptive ceiling for the list. Driven by how much room actually exists
    /// above the composer, so the popup shrinks with the window instead of
    /// overlapping the transcript or the Send row.
    let maxListHeight: CGFloat
    /// Echoed in the footer — makes "the popup is filtering on something other
    /// than what you typed" immediately visible.
    let query: String
    let onPick: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        // Identity MUST be the command, not the index. An
                        // earlier `.id(idx)` here overrode ForEach's identity
                        // with the array position: when the result set changed
                        // but the indices stayed 0...n, SwiftUI saw unchanged
                        // identities and reused the old row views verbatim —
                        // so the list showed stale commands while the count and
                        // the query indicator were both correct.
                        ForEach(Array(matches.enumerated()), id: \.element.id) { idx, cmd in
                            row(cmd, isSelected: idx == selected)
                                .id(cmd.id)
                                .contentShape(Rectangle())
                                .onTapGesture { onPick(idx) }
                        }
                    }
                }
                .frame(maxHeight: maxListHeight)
                .onChange(of: selected) { _, new in
                    guard matches.indices.contains(new) else { return }
                    withAnimation(.none) { proxy.scrollTo(matches[new].id, anchor: .center) }
                }
            }
            Divider()
            HStack(spacing: 10) {
                hint("↑↓", "navigate")
                hint("⇥", "complete")
                hint("⎋", "dismiss")
                Spacer()
                if !query.isEmpty {
                    Text("matching “\(query)”")
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                Text("\(matches.count) command\(matches.count == 1 ? "" : "s")")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
        }
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(nsColor: .controlBackgroundColor))
                .shadow(color: .black.opacity(0.18), radius: 12, y: 4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color(nsColor: .separatorColor), lineWidth: 0.5)
        )
    }

    @ViewBuilder
    private func row(_ cmd: SlashCommand, isSelected: Bool) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("/\(cmd.name)")
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(isSelected ? Color.accentColor : .primary)
                .layoutPriority(1)
            if !cmd.argumentHint.isEmpty {
                Text(cmd.argumentHint)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 12)
            if !cmd.description.isEmpty {
                Text(cmd.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: 460, alignment: .trailing)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(isSelected ? Color.accentColor.opacity(0.14) : Color.clear)
    }

    private func hint(_ key: String, _ label: String) -> some View {
        HStack(spacing: 3) {
            Text(key)
                .font(.caption2.monospaced())
                .padding(.horizontal, 4).padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 3).fill(Color.secondary.opacity(0.15)))
            Text(label).font(.caption2).foregroundStyle(.tertiary)
        }
    }
}
