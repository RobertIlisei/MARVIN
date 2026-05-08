// FindInFilesView — M3. Ripgrep-backed project-wide search.
// Lives in LeftPane's "Search" tab. Mirrors VS Code's sidebar search:
// query field, match options, include glob filter, replace field,
// collapsible per-file result groups, click-to-navigate.
// Results come from /api/files/search (rg --json).

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
            Divider()
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

                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                    .font(.system(size: 12))
                TextField("Search in files…", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .onSubmit { runSearch() }
                    .onChange(of: query) { _, _ in scheduleSearch() }
                if isSearching {
                    ProgressView().scaleEffect(0.6).frame(width: 14, height: 14)
                } else if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                    }.buttonStyle(.borderless)
                }
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
                    if let err = replaceError {
                        Image(systemName: "exclamationmark.circle")
                            .foregroundStyle(.orange)
                            .help(err)
                    }
                    if isReplacing {
                        ProgressView().scaleEffect(0.6).frame(width: 14, height: 14)
                    } else {
                        Button("All") { runReplaceAll() }
                            .font(.system(size: 11))
                            .buttonStyle(.borderedProminent)
                            .controlSize(.mini)
                            .disabled(query.isEmpty || results.isEmpty || replace.isEmpty)
                            .help("Replace all matches")
                    }
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
                    let total = results.reduce(0) { $0 + $1.matches.count }
                    Text("\(total) result\(total == 1 ? "" : "s") in \(results.count) file\(results.count == 1 ? "" : "s")")
                        .font(.system(size: 10))
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
    }

    private func optionToggle(label: String, tooltip: String, on: Binding<Bool>) -> some View {
        Button {
            on.wrappedValue.toggle()
        } label: {
            Text(label)
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 22, height: 18)
                .background(on.wrappedValue
                    ? Color.accentColor.opacity(0.2)
                    : Color(nsColor: .separatorColor).opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: 4))
                .foregroundStyle(on.wrappedValue ? Color.accentColor : Color.secondary)
        }
        .buttonStyle(.plain)
        .help(tooltip)
    }

    // MARK: - Results

    @ViewBuilder
    private var resultArea: some View {
        if let err = errorMessage {
            VStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(err).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if query.isEmpty {
            Text("Type to search across all files")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if !isSearching && results.isEmpty {
            Text("No results")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        let collapsed = collapsedFiles.contains(file.id.uuidString)
        return VStack(spacing: 0) {
            // File header row
            Button {
                if collapsed {
                    collapsedFiles.remove(file.id.uuidString)
                } else {
                    collapsedFiles.insert(file.id.uuidString)
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
            bridge.setSelectedFile(file.fullPath)
        } label: {
            HStack(spacing: 0) {
                // Line number gutter
                Text("\(match.line)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .trailing)
                    .padding(.trailing, 8)
                // Match text — highlight the query within the line
                highlightedText(match.text, query: query, caseSensitive: caseSensitive)
                    .lineLimit(1)
                    .truncationMode(.middle)
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
        aHit.font = .system(.body, design: .monospaced).weight(.semibold)
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
                for fileResult in results {
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
                }
                results = []
                await runSearchAsync(q)
            } catch {
                replaceError = error.localizedDescription
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
