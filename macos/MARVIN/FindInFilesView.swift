// FindInFilesView — M3. Ripgrep-backed project-wide search.
// Lives in LeftPane's "Search" tab. Mirrors VS Code's sidebar search:
// query field, match options, include glob filter, replace field,
// collapsible per-file result groups, click-to-navigate.
// Results come from /api/files/search (rg --json).

import MARVINLogic
import SwiftUI

// MARK: - Models

struct FindMatch: Identifiable {
    let id = UUID()
    let line: Int
    let col: Int
    let text: String
}

struct FindFileResult: Identifiable {
    let id = UUID()
    let relPath: String
    let fullPath: String
    let matches: [FindMatch]
}

// MARK: - View

struct FindInFilesView: View {
    @Environment(MarvinBridge.self) private var bridge

    @State private var query: String = ""
    /// ⌘⇧F puts the caret here. The pane had no way to reach its own field
    /// from the keyboard (ADR-0114).
    @FocusState private var queryFocused: Bool
    /// The confirm for Replace All, which had none.
    @State private var confirmingReplace = false
    /// The file a part-finished Replace All stopped on.
    @State private var stoppedOn: String?
    @State private var replace: String = ""
    @State private var includeGlob: String = ""
    @State private var caseSensitive: Bool = false
    @State private var wholeWord: Bool = false
    @State private var useRegex: Bool = false
    @State private var replaceExpanded: Bool = false

    @State private var results: [FindFileResult] = []
    @State private var truncated: Bool = false
    @State private var isSearching: Bool = false
    @State private var isReplacing: Bool = false
    @State private var replaceError: String? = nil
    @State private var errorMessage: String? = nil
    @State private var collapsedFiles: Set<String> = []

    @State private var searchTask: Task<Void, Never>? = nil

    var body: some View {
        VStack(spacing: 0) {
            searchBar
            MarvinDivider()
            resultArea
        }
    }

    // MARK: - Search bar

    private var searchBar: some View {
        VStack(spacing: 0) {
            // Search row
            HStack(spacing: 6) {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) { replaceExpanded.toggle() }
                } label: {
                    Image(systemName: replaceExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                }
                .buttonStyle(.plain)
                .help("Toggle replace")

                // A field that looks like one. `.plain` on all three fields
                // meant the search box read as a label until you clicked it
                // (ADR-0114).
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)
                        .font(.system(size: 11))
                    TextField("Search in files…", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                        .focused($queryFocused)
                        .onSubmit { runSearch() }
                        .onChange(of: query) { _, _ in scheduleSearch() }
                    if isSearching {
                        ProgressView().scaleEffect(0.6).frame(width: 14, height: 14)
                    } else if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.plain)
                        .help("Clear the search")
                    }
                }
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                        .fill(MarvinTheme.elevated)
                        .overlay(
                            RoundedRectangle(cornerRadius: MarvinTheme.Radius.chip, style: .continuous)
                                .strokeBorder(queryFocused ? Color.accentColor.opacity(0.55) : MarvinTheme.border, lineWidth: 1)
                        )
                )
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)

            // Replace row (collapsible)
            if replaceExpanded {
                HStack(spacing: 6) {
                    Spacer().frame(width: 14)
                    Image(systemName: "arrow.left.arrow.right")
                        .foregroundStyle(.secondary)
                        .font(.system(size: 12))
                    TextField("Replace…", text: $replace)
                        .textFieldStyle(.plain)
                        .font(.system(size: 12))
                    if replaceError != nil {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(GitDecorationColor.deleted)
                    }
                    if isReplacing {
                        ProgressView().scaleEffect(0.6).frame(width: 14, height: 14)
                    } else {
                        // Was: one click, no confirm, no preview, no undo,
                        // writing file by file with the only error report a
                        // tooltip-sized icon. It is the most destructive
                        // control in the sidebar (ADR-0114).
                        Button("Replace All…") { confirmingReplace = true }
                            .rowChip(.tinted(GitDecorationColor.deleted))
                            .disabled(query.isEmpty || results.isEmpty || replace.isEmpty || regexError != nil)
                            .help("Rewrite every match in every file listed below. There is no undo.")
                            .confirmationDialog(
                                "Replace \(matchTotal) match\(matchTotal == 1 ? "" : "es") in \(results.count) file\(results.count == 1 ? "" : "s")?",
                                isPresented: $confirmingReplace,
                                titleVisibility: .visible
                            ) {
                                Button("Replace All", role: .destructive) { runReplaceAll() }
                                Button("Cancel", role: .cancel) {}
                            } message: {
                                Text("“\(query)” becomes “\(replace)” on disk. This writes the files directly and cannot be undone from here.")
                            }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
            }

            if let replaceError {
                // A failure that rewrote half a repository reported itself in
                // a tooltip on a 10pt icon. It gets a line (ADR-0114).
                HStack(spacing: 5) {
                    Image(systemName: PaneNotice.Kind.error.symbol)
                        .font(.system(size: 9))
                        .foregroundStyle(PaneNotice.Kind.error.tint)
                    Text(replaceError)
                        .font(.system(size: 10))
                        .foregroundStyle(MarvinTheme.textPrimary)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button {
                        self.replaceError = nil
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 8, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tertiary)
                    .help("Dismiss")
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
            }

            if let regexError {
                HStack(spacing: 5) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(.orange)
                    Text(regexError)
                        .font(.system(size: 10))
                        .foregroundStyle(.orange)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)
            }

            // Options row
            HStack(spacing: 4) {
                optionToggle(label: "Aa", tooltip: "Case sensitive", on: $caseSensitive)
                optionToggle(label: "\\b", tooltip: "Whole word", on: $wholeWord)
                optionToggle(label: ".*", tooltip: "Use regex", on: $useRegex)
                Spacer()
                if !results.isEmpty {
                    Text("\(matchTotal) result\(matchTotal == 1 ? "" : "s") in \(results.count) file\(results.count == 1 ? "" : "s")")
                        .font(.system(size: 10).monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.top, 6)

            // Include glob filter row
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal.decrease")
                    .foregroundStyle(.tertiary)
                    .font(.system(size: 11))
                TextField("files to include (e.g. *.ts, src/**)", text: $includeGlob)
                    .textFieldStyle(.plain)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .onSubmit { runSearch() }
                    .onChange(of: includeGlob) { _, _ in scheduleSearch() }
                if !includeGlob.isEmpty {
                    Button { includeGlob = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }.buttonStyle(.borderless).font(.system(size: 10))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .onChange(of: caseSensitive) { _, _ in scheduleSearch() }
        .onChange(of: wholeWord) { _, _ in scheduleSearch() }
        .onChange(of: useRegex) { _, _ in scheduleSearch() }
        .onChange(of: bridge.focusSearchField) { _, want in
            guard want else { return }
            queryFocused = true
            bridge.focusSearchField = false
        }
    }

    /// `Aa` `\b` `.*` — three toggles that were 22×18pt of tinted text with
    /// no press state, no focus ring and no name for VoiceOver (ADR-0114).
    /// A regex the user typed that will not compile. Checked here so the
    /// answer appears under the field rather than as a generic server error
    /// in the results area (ADR-0114).
    /// Every match currently listed. Named once so the count in the options
    /// row and the count in the replace confirmation cannot disagree.
    private var matchTotal: Int { results.reduce(0) { $0 + $1.matches.count } }

    private var regexError: String? {
        guard useRegex else { return nil }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else { return nil }
        do {
            _ = try NSRegularExpression(pattern: q)
            return nil
        } catch {
            return "Not a valid regular expression: \(error.localizedDescription)"
        }
    }

    private func optionToggle(label: String, tooltip: String, on: Binding<Bool>) -> some View {
        Button {
            on.wrappedValue.toggle()
        } label: {
            Text(label)
                .font(.system(size: 11, design: .monospaced))
                .frame(minWidth: 26, minHeight: 22)
                .contentShape(Rectangle())
        }
        .rowChip(on.wrappedValue ? .primary : .neutral)
        .help(tooltip)
        .accessibilityLabel(tooltip)
        .accessibilityAddTraits(on.wrappedValue ? [.isSelected] : [])
    }

    // MARK: - Results

    @ViewBuilder
    private var resultArea: some View {
        if let err = errorMessage {
            PaneEmptyView(
                state: PaneEmptyState(headline: "The search could not run", hint: err, symbol: "exclamationmark.triangle"),
                actionTitle: "Try again",
                action: { runSearch() }
            )
            .frame(maxHeight: .infinity)
        } else if query.isEmpty {
            PaneEmptyView(state: PaneEmptyState(
                headline: "Search every file in this project",
                hint: "`Aa` matches case, `\\b` whole words, `.*` treats the query as a regular expression. The filter below narrows it to matching paths.",
                symbol: "magnifyingglass"
            ))
            .frame(maxHeight: .infinity)
        } else if !isSearching && results.isEmpty {
            PaneEmptyView(state: .noResults(query: query))
                .frame(maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(results) { file in
                        fileSection(file)
                    }
                    if truncated {
                        Text("Result limit reached — narrow your search")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .padding(8)
                    }
                }
            }
        }
    }

    private func fileSection(_ file: FindFileResult) -> some View {
        let collapsed = collapsedFiles.contains(file.relPath)
        return VStack(spacing: 0) {
            // File header row
            Button {
                if collapsed {
                    collapsedFiles.remove(file.relPath)
                } else {
                    collapsedFiles.insert(file.relPath)
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                        .frame(width: 10)
                    let kind = FileTypeIcon.kind(for: file.relPath)
                    Image(systemName: FileTypeIcon.symbol(for: kind))
                        .font(.system(size: 10))
                        .foregroundStyle(FileTypeIcon.color(for: kind))
                    Text((file.relPath as NSString).lastPathComponent)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(parentDir(of: file.relPath))
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer()
                    Text("\(file.matches.count)")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .background(Color(nsColor: .separatorColor).opacity(0.4))
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(Color(nsColor: .controlBackgroundColor))

            // Match rows
            if !collapsed {
                ForEach(file.matches) { match in
                    matchRow(match: match, file: file)
                }
            }
        }
    }

    private func matchRow(match: FindMatch, file: FindFileResult) -> some View {
        Button {
            // The line was decoded, rendered in the gutter two lines below,
            // and then thrown away: clicking a result opened the file at the
            // top and left you to find the match yourself. `openFileFromChat`
            // already scrolls, and has since the chat links needed it
            // (2026-09-11).
            bridge.openFileFromChat(path: file.fullPath, line: match.line)
        } label: {
            HStack(spacing: 0) {
                // Line number gutter
                Text("\(match.line)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .trailing)
                    .padding(.trailing, 8)
                // Match text — highlight the query within the line
                // Truncate the TAIL, not the middle: the middle of a matched
                // line is exactly the part you searched for.
                highlightedText(match.text, query: query, caseSensitive: caseSensitive)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
            }
            .padding(.vertical, 3)
            .padding(.leading, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(Color.clear)
        .hoverEffect()
    }

    // Highlights the first occurrence of `query` in `text` using
    // AttributedString so we don't pull in a regex dependency.
    private func highlightedText(_ text: String, query: String, caseSensitive: Bool) -> Text {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else {
            return Text(trimmed).font(.system(size: 11, design: .monospaced))
        }
        let options: String.CompareOptions = caseSensitive ? [] : .caseInsensitive
        guard let range = trimmed.range(of: query, options: options) else {
            return Text(trimmed).font(.system(size: 11, design: .monospaced))
        }
        let before = String(trimmed[..<range.lowerBound])
        let hit    = String(trimmed[range])
        let after  = String(trimmed[range.upperBound...])
        // AttributedString-based highlight so we avoid Text + Text
        // concatenation (deprecated macOS 26+).
        var aStr = AttributedString(before)
        aStr.font = .system(size: 11, design: .monospaced)
        aStr.foregroundColor = NSColor.secondaryLabelColor

        var aHit = AttributedString(hit)
        // Same size as its neighbours. `.body` here made the one token you
        // searched for jump larger than the line it sits in, so the match
        // reflowed the row it was supposed to mark.
        aHit.font = .system(size: 11, design: .monospaced).weight(.semibold)
        aHit.foregroundColor = NSColor.labelColor
        aStr += aHit

        var aAfter = AttributedString(after)
        aAfter.font = .system(size: 11, design: .monospaced)
        aAfter.foregroundColor = NSColor.secondaryLabelColor
        aStr += aAfter

        return Text(aStr)
    }

    // MARK: - Search logic

    private func scheduleSearch() {
        searchTask?.cancel()
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 2 else {
            results = []
            errorMessage = nil
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000) // 300 ms debounce
            guard !Task.isCancelled else { return }
            await runSearchAsync(q)
        }
    }

    private func runSearch() {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard q.count >= 1 else { return }
        searchTask?.cancel()
        searchTask = Task { await runSearchAsync(q) }
    }

    @MainActor
    private func runSearchAsync(_ q: String) async {
        guard let cwd = bridge.projectWorkDir else { return }
        isSearching = true
        errorMessage = nil
        defer { isSearching = false }

        do {
            var components = URLComponents(string: "\(ServerConfig.baseURLString)/api/files/search")!
            var queryItems: [URLQueryItem] = [
                URLQueryItem(name: "cwd", value: cwd),
                URLQueryItem(name: "q", value: q),
                URLQueryItem(name: "caseSensitive", value: caseSensitive ? "1" : "0"),
                URLQueryItem(name: "wholeWord", value: wholeWord ? "1" : "0"),
                URLQueryItem(name: "useRegex", value: useRegex ? "1" : "0"),
            ]
            let trimmedGlob = includeGlob.trimmingCharacters(in: .whitespaces)
            if !trimmedGlob.isEmpty {
                queryItems.append(URLQueryItem(name: "include", value: trimmedGlob))
            }
            components.queryItems = queryItems
            let (data, _) = try await URLSession.shared.data(from: components.url!)
            let decoded = try JSONDecoder().decode(SearchAPIResponse.self, from: data)
            results = decoded.results.map { r in
                let full = cwd + "/" + r.file
                let matches = r.matches.map { m in FindMatch(line: m.line, col: m.col, text: m.text) }
                return FindFileResult(relPath: r.file, fullPath: full, matches: matches)
            }
            truncated = decoded.truncated
        } catch is CancellationError {
        } catch {
            guard !BenignCancellation.matches(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func runReplaceAll() {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let r = replace
        guard !q.isEmpty, !results.isEmpty else { return }
        guard let cwd = bridge.projectWorkDir else { return }
        isReplacing = true
        replaceError = nil
        Task { @MainActor in
            defer { isReplacing = false }
            do {
                var done = 0
                for fileResult in results {
                    stoppedOn = fileResult.relPath
                    let resp = try await FilesService.shared.fetchContent(
                        cwd: cwd, path: fileResult.relPath
                    )
                    guard !resp.binary, let text = resp.content else { continue }
                    let newText: String
                    if useRegex {
                        let opts: NSRegularExpression.Options =
                            caseSensitive ? [] : .caseInsensitive
                        let rx = try NSRegularExpression(pattern: q, options: opts)
                        let range = NSRange(text.startIndex..., in: text)
                        newText = rx.stringByReplacingMatches(
                            in: text, range: range, withTemplate: r
                        )
                    } else {
                        let opts: String.CompareOptions =
                            caseSensitive ? [.literal] : [.caseInsensitive, .literal]
                        newText = text.replacingOccurrences(of: q, with: r, options: opts)
                    }
                    guard newText != text else { continue }
                    _ = try await FilesService.shared.saveFile(
                        cwd: cwd, path: fileResult.relPath, content: newText
                    )
                    done += 1
                }
                stoppedOn = nil
                results = []
                await runSearchAsync(q)
            } catch {
                // The loop writes file by file, so a throw halfway leaves the
                // project part-replaced. Saying which file it stopped on is
                // the difference between "something went wrong" and a way
                // back (ADR-0114).
                replaceError = stoppedOn.map { "Stopped at \($0): \(error.localizedDescription). Files before it were already rewritten." }
                    ?? error.localizedDescription
            }
        }
    }

    private func parentDir(of relPath: String) -> String {
        let dir = (relPath as NSString).deletingLastPathComponent
        return dir.isEmpty || dir == "." ? "" : dir
    }
}

// MARK: - Hover effect helper

private extension View {
    func hoverEffect() -> some View {
        self.modifier(HoverHighlight())
    }
}

private struct HoverHighlight: ViewModifier {
    @State private var hovered = false
    func body(content: Content) -> some View {
        content
            .background(hovered ? Color.accentColor.opacity(0.1) : Color.clear)
            .onHover { hovered = $0 }
    }
}

// MARK: - API response models

private struct SearchAPIResponse: Decodable {
    let results: [APIFileResult]
    let truncated: Bool

    struct APIFileResult: Decodable {
        let file: String
        let matches: [APIMatch]
    }

    struct APIMatch: Decodable {
        let line: Int
        let col: Int
        let text: String
    }
}
