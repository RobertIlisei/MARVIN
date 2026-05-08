// TerminalPaneView — Phase 5e. Native peer of the web app's
// Terminal (sidecar/src/components/terminal/terminal.tsx).
//
// Design choice: the existing `/api/terminal/run` endpoint is a
// one-shot command runner streaming SSE events (started / stdout /
// stderr / exit). It is NOT a PTY. So this surface is a "command
// runner with scrollback", not a fully interactive shell. That
// matches the web peer exactly. A real PTY-backed interactive
// shell would need server-side PTY plumbing + SwiftTerm — both
// big lifts deferred to a future phase.
//
// IDE convention this matches:
//   • Bottom panel layout (VS Code's terminal pane shape)
//   • Up/Down arrow → command history
//   • ⌘K → clear scrollback
//   • Run button + Enter both submit
//   • ANSI colour passthrough is a stretch goal; we strip ANSI
//     escape sequences to keep the renderer simple.

import SwiftUI
import MARVINLogic

struct TerminalPaneView: View {
    @Environment(MarvinBridge.self) private var bridge

    private static let historyKey = "marvin.term.history"
    private static let historyMax = 100

    @State private var input: String = ""
    @State private var lines: [TermLine] = []
    @State private var history: [String] = []
    @State private var historyIndex: Int = -1
    @State private var isRunning: Bool = false
    @State private var runner: TerminalRunner? = nil
    @FocusState private var inputFocused: Bool

    private struct TermLine: Identifiable {
        let id = UUID()
        let kind: Kind
        let text: String
        enum Kind { case prompt, stdout, stderr, info }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            scrollback
            Divider()
            inputBar
        }
        .background(Color(nsColor: .textBackgroundColor))
        .onAppear {
            history = Self.loadHistory()
            inputFocused = true
        }
        // M7: BuildTaskSheet injects a command via bridge.pendingTerminalCommand.
        // We observe it here and execute it so the task runner can drive the terminal.
        .onChange(of: bridge.pendingTerminalCommand) { _, cmd in
            guard let cmd, !cmd.isEmpty else { return }
            bridge.consumePendingTerminalCommand()
            input = cmd
            submit()
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("TERMINAL")
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.tertiary)
            if let cwd = bridge.projectWorkDir {
                Text(cwd)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            } else {
                Text("(no project)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if isRunning {
                Button {
                    runner?.cancel()
                } label: {
                    Label("Stop", systemImage: "stop.circle.fill")
                        .font(.system(size: 11))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.red)
                .help("Send SIGTERM to the running command")
            }
            Button {
                lines.removeAll()
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .keyboardShortcut("k", modifiers: [.command])
            .help("Clear scrollback (⌘K)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    private var scrollback: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if lines.isEmpty {
                        Text("Type a command and press ⏎. Output streams here.")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .padding(12)
                    } else {
                        ForEach(lines) { line in
                            lineView(line)
                                .id(line.id)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .onChange(of: lines.count) { _, _ in
                withAnimation(.linear(duration: 0.05)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func lineView(_ line: TermLine) -> some View {
        let color: Color = {
            switch line.kind {
            case .prompt: return Color.accentColor
            case .stdout: return .primary
            case .stderr: return .red
            case .info:   return .secondary
            }
        }()
        return Text(stripANSI(line.text))
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
    }

    private var inputBar: some View {
        HStack(spacing: 8) {
            Text("❯")
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(Color.accentColor)
            TextField("command", text: $input)
                .textFieldStyle(.plain)
                .font(.system(size: 12, design: .monospaced))
                .focused($inputFocused)
                .disabled(isRunning || bridge.projectWorkDir == nil)
                .onSubmit { submit() }
                .onKeyPress(.upArrow) {
                    historyPrev()
                    return .handled
                }
                .onKeyPress(.downArrow) {
                    historyNext()
                    return .handled
                }
            Button("Run") { submit() }
                .buttonStyle(.bordered)
                .disabled(input.trimmingCharacters(in: .whitespaces).isEmpty
                          || isRunning
                          || bridge.projectWorkDir == nil)
                .keyboardShortcut(.defaultAction)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .underPageBackgroundColor))
    }

    // MARK: - Submit + history

    private func submit() {
        let cmd = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty, !isRunning else { return }
        guard let cwd = bridge.projectWorkDir else { return }
        lines.append(TermLine(kind: .prompt, text: "❯ \(cmd)"))
        appendHistory(cmd)
        input = ""
        historyIndex = -1
        isRunning = true

        let r = TerminalRunner()
        runner = r
        Task {
            await r.run(cwd: cwd, cmd: cmd) { event in
                switch event {
                case .started(_):
                    break
                case .stdout(let data):
                    appendStreamChunk(data, kind: .stdout)
                case .stderr(let data):
                    appendStreamChunk(data, kind: .stderr)
                case .exit(let code, let signal, let durationMs):
                    let dur = DurationFormat.humanize(ms: durationMs)
                    let summary: String = {
                        if let signal {
                            return "[exit signal=\(signal) · \(dur)]"
                        }
                        return "[exit \(code ?? -1) · \(dur)]"
                    }()
                    lines.append(TermLine(kind: .info, text: summary))
                case .error(let message):
                    lines.append(TermLine(kind: .stderr, text: "[error] \(message)"))
                case .end:
                    isRunning = false
                    runner = nil
                }
            }
        }
    }

    /// Append streaming bytes to the scrollback. The stream is split
    /// on \n so we land one line per row — multiple rows can come
    /// from one chunk if the upstream writes buffered data.
    private func appendStreamChunk(_ chunk: String, kind: TermLine.Kind) {
        let pieces = chunk.split(
            separator: "\n",
            omittingEmptySubsequences: false
        ).map(String.init)
        for (i, piece) in pieces.enumerated() {
            if i == 0, let last = lines.last,
               (last.kind == .stdout || last.kind == .stderr),
               last.kind == kind,
               !piece.isEmpty {
                // Concatenate with the previous partial line — the
                // upstream chunk boundary doesn't always align with
                // a newline.
                lines[lines.count - 1] = TermLine(kind: kind, text: last.text + piece)
            } else {
                if piece.isEmpty && i == pieces.count - 1 { continue }
                lines.append(TermLine(kind: kind, text: piece))
            }
        }
    }

    private func historyPrev() {
        guard !history.isEmpty else { return }
        if historyIndex == -1 { historyIndex = history.count - 1 }
        else if historyIndex > 0 { historyIndex -= 1 }
        input = history[historyIndex]
    }

    private func historyNext() {
        guard historyIndex >= 0 else { return }
        if historyIndex < history.count - 1 {
            historyIndex += 1
            input = history[historyIndex]
        } else {
            historyIndex = -1
            input = ""
        }
    }

    private func appendHistory(_ cmd: String) {
        if history.last == cmd { return }
        history.append(cmd)
        if history.count > Self.historyMax {
            history.removeFirst(history.count - Self.historyMax)
        }
        Self.saveHistory(history)
    }

    private static func loadHistory() -> [String] {
        UserDefaults.standard.stringArray(forKey: historyKey) ?? []
    }
    private static func saveHistory(_ h: [String]) {
        UserDefaults.standard.set(h, forKey: historyKey)
    }

    /// Strip ANSI CSI / OSC escape sequences. Real ANSI parsing would
    /// preserve colours; for the first cut we just hide the escape
    /// codes so they don't render as garbage in the monospace text.
    private func stripANSI(_ s: String) -> String {
        // ESC [ ... m (and other CSI terminators)
        let csiPattern = "\u{001B}\\[[0-9;?]*[ -/]*[@-~]"
        // ESC ] ... BEL (OSC). Less common; covered for safety.
        let oscPattern = "\u{001B}\\][^\u{0007}]*\u{0007}"
        var out = s
        for pat in [csiPattern, oscPattern] {
            if let regex = try? NSRegularExpression(pattern: pat) {
                let ns = out as NSString
                out = regex.stringByReplacingMatches(
                    in: out,
                    range: NSRange(location: 0, length: ns.length),
                    withTemplate: ""
                )
            }
        }
        return out
    }
}

// MARK: - SSE runner

/// Thin SSE consumer for /api/terminal/run. Owns the URLSession
/// data task and yields parsed events to a callback. The callback
/// runs on @MainActor so the view layer can mutate state directly.
@MainActor
final class TerminalRunner {
    enum Event {
        case started(pid: Int?)
        case stdout(String)
        case stderr(String)
        case exit(code: Int?, signal: String?, durationMs: Int)
        case error(String)
        case end
    }

    private var task: URLSessionDataTask?

    func cancel() {
        task?.cancel()
    }

    func run(
        cwd: String,
        cmd: String,
        emit: @escaping @MainActor (Event) -> Void
    ) async {
        let url = ServerConfig.baseURL.appendingPathComponent("api/terminal/run")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        req.timeoutInterval = .infinity
        let body: [String: String] = ["cwd": cwd, "cmd": cmd]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: req)
            guard let http = response as? HTTPURLResponse else {
                emit(.error("bad response"))
                emit(.end)
                return
            }
            if !(200..<300).contains(http.statusCode) {
                emit(.error("HTTP \(http.statusCode)"))
                emit(.end)
                return
            }
            // SSE parser — events are blocks separated by \n\n, each
            // block has `event: <name>` and `data: <json>` lines.
            var pendingEvent: String? = nil
            var pendingData: String = ""
            for try await line in bytes.lines {
                if line.isEmpty {
                    // Dispatch the assembled event.
                    if let name = pendingEvent {
                        Self.dispatch(name: name, data: pendingData, emit: emit)
                    }
                    pendingEvent = nil
                    pendingData = ""
                    continue
                }
                if line.hasPrefix("event: ") {
                    pendingEvent = String(line.dropFirst("event: ".count))
                } else if line.hasPrefix("data: ") {
                    if !pendingData.isEmpty { pendingData += "\n" }
                    pendingData += String(line.dropFirst("data: ".count))
                }
            }
            // Flush any trailing event without a closing blank line.
            if let name = pendingEvent {
                Self.dispatch(name: name, data: pendingData, emit: emit)
            }
            emit(.end)
        } catch {
            emit(.error(error.localizedDescription))
            emit(.end)
        }
    }

    private static func dispatch(
        name: String,
        data: String,
        emit: @MainActor (Event) -> Void
    ) {
        guard let json = data.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: json) as? [String: Any]
        else {
            return
        }
        switch name {
        case "started":
            emit(.started(pid: parsed["pid"] as? Int))
        case "stdout":
            if let s = parsed["data"] as? String { emit(.stdout(s)) }
        case "stderr":
            if let s = parsed["data"] as? String { emit(.stderr(s)) }
        case "exit":
            let code = parsed["code"] as? Int
            let signal = parsed["signal"] as? String
            let dur = parsed["durationMs"] as? Int ?? 0
            emit(.exit(code: code, signal: signal, durationMs: dur))
        default:
            break
        }
    }
}
