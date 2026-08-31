// LSPClient — one language server, over stdio (ADR-0099).
//
// JSON-RPC 2.0 with LSP's `Content-Length` framing, which
// `MARVINLogic/LSPMessageFraming` owns and is tested without a subprocess.
// This file owns everything that needs a running process: the handshake,
// document sync, and the crash path.
//
// ## Three things that bite, all handled here
//
//   • **The server asks US questions.** `client/registerCapability`,
//     `workspace/configuration` and `window/workDoneProgress/create` are
//     server→client REQUESTS, not notifications. A client that ignores
//     them looks alive and then quietly stalls, because a conforming
//     server waits for the reply before continuing.
//   • **stderr is not diagnostics.** Some servers are chatty on stderr
//     while working perfectly. It is drained (an undrained pipe blocks the
//     writer at 64 KB) and kept only for the failure message.
//   • **A crashing server must stop being restarted.** The service above
//     enforces a strike limit; respawning forever is a battery bug.

import Foundation
import MARVINLogic

// MARK: - Server registry

/// How to recognise a language and what to launch for it.
struct LSPServerSpec {
    let id: String
    /// LSP `languageId` — servers key behaviour off this exact string.
    let languageId: String
    let fileExtensions: Set<String>
    let command: String
    let args: [String]

    /// The servers MARVIN knows how to talk to. Presence is the user's
    /// business: MARVIN never installs a toolchain (ADR-0099).
    static let all: [LSPServerSpec] = [
        LSPServerSpec(
            id: "sourcekit-lsp", languageId: "swift",
            fileExtensions: ["swift"],
            command: "sourcekit-lsp", args: []
        ),
        LSPServerSpec(
            id: "typescript-language-server", languageId: "typescript",
            fileExtensions: ["ts", "tsx", "js", "jsx", "mts", "cts"],
            command: "typescript-language-server", args: ["--stdio"]
        ),
        LSPServerSpec(
            id: "gopls", languageId: "go",
            fileExtensions: ["go"], command: "gopls", args: []
        ),
        LSPServerSpec(
            id: "rust-analyzer", languageId: "rust",
            fileExtensions: ["rs"], command: "rust-analyzer", args: []
        ),
        LSPServerSpec(
            id: "clangd", languageId: "cpp",
            fileExtensions: ["c", "h", "cc", "cpp", "hpp", "m", "mm"],
            command: "clangd", args: []
        ),
        LSPServerSpec(
            id: "pyright", languageId: "python",
            fileExtensions: ["py"],
            command: "pyright-langserver", args: ["--stdio"]
        ),
    ]

    static func forFile(_ path: String) -> LSPServerSpec? {
        let ext = (path as NSString).pathExtension.lowercased()
        guard !ext.isEmpty else { return nil }
        return all.first { $0.fileExtensions.contains(ext) }
    }
}

// MARK: - Client

@MainActor
final class LSPClient {
    let spec: LSPServerSpec
    let root: String

    /// Called with (absolute path, diagnostics) on every publish.
    var onDiagnostics: ((String, [DiagnosticItem]) -> Void)?
    /// Called once when the server dies.
    var onExit: ((String) -> Void)?

    private(set) var isReady = false
    private(set) var serverName: String?

    private var process: Process?
    private var stdin: FileHandle?
    private var decoder = LSPMessageFraming.Decoder()
    private var nextId = 1
    private var openDocs: [String: Int] = [:]   // path → version
    private var stderrTail = ""
    /// Requests awaiting a reply, by JSON-RPC id. LSP replies arrive out of
    /// order and interleaved with server-initiated traffic, so the id is
    /// the only thing tying a response to its question.
    private var pending: [Int: (Any?) -> Void] = [:]

    init(spec: LSPServerSpec, root: String) {
        self.spec = spec
        self.root = root
    }

    // MARK: Lifecycle

    /// Resolved executable path, or nil when the server is not installed.
    /// The caller surfaces that as a diagnostic — never silence.
    static func resolve(_ spec: LSPServerSpec, root: String) -> String? {
        ToolLocator.locate(spec.command, workDir: root)
    }

    func start() -> Bool {
        guard let exec = Self.resolve(spec, root: root) else { return false }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exec)
        p.arguments = spec.args
        p.currentDirectoryURL = URL(fileURLWithPath: root)
        var env = ProcessInfo.processInfo.environment
        // A Finder launch inherits the bare launchd PATH; every one of these
        // servers shells out to its own toolchain.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(NSHomeDirectory())/.cargo/bin:"
            + "\(NSHomeDirectory())/go/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env

        let inPipe = Pipe(), outPipe = Pipe(), errPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty else { return }
            Task { @MainActor [weak self] in self?.ingest(chunk) }
        }
        // Drained but not parsed: an undrained pipe blocks the server at
        // 64 KB, and a chatty server is not a broken one.
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty,
                  let text = String(data: chunk, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.stderrTail = String((self.stderrTail + text).suffix(2000))
            }
        }
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.isReady = false
                let tail = self.stderrTail.suffix(300)
                self.onExit?(
                    "exited with status \(status)"
                        + (tail.isEmpty ? "" : ": \(tail)")
                )
            }
        }

        do { try p.run() } catch { return false }
        process = p
        stdin = inPipe.fileHandleForWriting
        handshake()
        return true
    }

    func stop() {
        guard let p = process, p.isRunning else { return }
        p.terminationHandler = nil
        notify("exit", [:])
        p.terminate()
        process = nil
        stdin = nil
        isReady = false
    }

    private func handshake() {
        // `processId` lets the server exit on its own if we die without
        // saying so — otherwise a crashed MARVIN leaks a language server.
        request("initialize", [
            "processId": NSNumber(value: ProcessInfo.processInfo.processIdentifier),
            "rootUri": Self.fileURI(root),
            "workspaceFolders": [
                ["uri": Self.fileURI(root), "name": (root as NSString).lastPathComponent]
            ],
            "capabilities": [
                "textDocument": [
                    "synchronization": [
                        // FULL sync: incremental is an optimisation with a
                        // whole class of desync bugs behind it, and a file
                        // an editor holds open is small (ADR-0099).
                        "didSave": false, "willSave": false,
                        "dynamicRegistration": false,
                    ],
                    "publishDiagnostics": ["relatedInformation": true],
                ],
                "workspace": ["workspaceFolders": true, "configuration": true],
                "window": ["workDoneProgress": true],
            ],
        ])
    }

    // MARK: Document sync

    func didOpen(path: String, text: String) {
        guard isReady, openDocs[path] == nil else { return }
        openDocs[path] = 1
        notify("textDocument/didOpen", [
            "textDocument": [
                "uri": Self.fileURI(path),
                "languageId": spec.languageId,
                "version": 1,
                "text": text,
            ],
        ])
    }

    func didChange(path: String, text: String) {
        guard isReady, let version = openDocs[path] else { return }
        let next = version + 1
        openDocs[path] = next
        notify("textDocument/didChange", [
            "textDocument": ["uri": Self.fileURI(path), "version": next],
            "contentChanges": [["text": text]],
        ])
    }

    func didClose(path: String) {
        guard isReady, openDocs[path] != nil else { return }
        openDocs.removeValue(forKey: path)
        notify("textDocument/didClose", [
            "textDocument": ["uri": Self.fileURI(path)],
        ])
    }

    var openDocumentCount: Int { openDocs.count }

    // MARK: Transport

    private func request(
        _ method: String, _ params: [String: Any],
        reply: ((Any?) -> Void)? = nil
    ) {
        let id = nextId
        nextId += 1
        if let reply {
            pending[id] = reply
            // Never leak a continuation: a server that answers nothing must
            // not leave the caller's completion hanging forever.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, let late = self.pending.removeValue(forKey: id) else { return }
                late(nil)
            }
        }
        send(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
    }

    // MARK: - Requests with answers

    /// `textDocument/definition`. Answers with the first location the
    /// server returns; servers may reply with a single `Location`, an
    /// array, or `LocationLink`s, and all three shapes appear in the wild.
    func definition(
        path: String, line: Int, column: Int,
        completion: @escaping (_ path: String, _ line: Int) -> Void
    ) {
        guard isReady else { return }
        request("textDocument/definition", [
            "textDocument": ["uri": Self.fileURI(path)],
            "position": [
                "line": LSPPosition.fromDisplayLine(line),
                "character": max(0, column - 1),
            ],
        ]) { result in
            guard let hit = Self.firstLocation(result) else { return }
            completion(hit.0, hit.1)
        }
    }

    /// Normalises `Location | Location[] | LocationLink[]` to (path, line).
    private static func firstLocation(_ result: Any?) -> (String, Int)? {
        func fromObject(_ o: [String: Any]) -> (String, Int)? {
            // LocationLink uses `targetUri`/`targetSelectionRange`;
            // Location uses `uri`/`range`.
            let uri = (o["uri"] as? String) ?? (o["targetUri"] as? String)
            let range = (o["range"] as? [String: Any])
                ?? (o["targetSelectionRange"] as? [String: Any])
                ?? (o["targetRange"] as? [String: Any])
            guard let uri,
                  let start = range?["start"] as? [String: Any],
                  let line = start["line"] as? Int else { return nil }
            return (path(fromURI: uri), LSPPosition.toDisplayLine(line))
        }
        if let o = result as? [String: Any] { return fromObject(o) }
        if let arr = result as? [[String: Any]] {
            for o in arr { if let hit = fromObject(o) { return hit } }
        }
        return nil
    }

    private func notify(_ method: String, _ params: [String: Any]) {
        send(["jsonrpc": "2.0", "method": method, "params": params])
    }

    private func respond(id: Any, result: Any) {
        send(["jsonrpc": "2.0", "id": id, "result": result])
    }

    private func send(_ message: [String: Any]) {
        guard let stdin,
              let body = try? JSONSerialization.data(withJSONObject: message)
        else { return }
        // The server may have exited between our check and this write.
        try? stdin.write(contentsOf: LSPMessageFraming.encode(body))
    }

    private func ingest(_ chunk: Data) {
        for message in decoder.feed(chunk) {
            guard let obj = try? JSONSerialization.jsonObject(with: message)
                    as? [String: Any] else { continue }
            handle(obj)
        }
    }

    private func handle(_ msg: [String: Any]) {
        if let method = msg["method"] as? String {
            if let id = msg["id"] {
                handleServerRequest(method: method, id: id)
            } else {
                handleNotification(method: method, params: msg["params"])
            }
            return
        }
        // A response.
        if let id = msg["id"] as? Int, let handler = pending.removeValue(forKey: id) {
            handler(msg["result"])
            return
        }
        if let result = msg["result"] as? [String: Any], !isReady {
            isReady = true
            if let info = result["serverInfo"] as? [String: Any] {
                serverName = info["name"] as? String
            }
            notify("initialized", [:])
        }
    }

    /// Server→client requests. Ignoring these is the classic "the server
    /// starts and then nothing ever happens" bug: a conforming server
    /// blocks waiting for the reply.
    private func handleServerRequest(method: String, id: Any) {
        switch method {
        case "workspace/configuration":
            // One null per requested section; we configure nothing, and
            // every server accepts its defaults for that.
            respond(id: id, result: [NSNull()])
        default:
            respond(id: id, result: NSNull())
        }
    }

    private func handleNotification(method: String, params: Any?) {
        guard method == "textDocument/publishDiagnostics",
              let p = params as? [String: Any],
              let uri = p["uri"] as? String else { return }
        let path = Self.path(fromURI: uri)
        let raw = p["diagnostics"] as? [[String: Any]] ?? []
        onDiagnostics?(
            path, raw.compactMap { Self.item(from: $0, path: path, source: spec.id) }
        )
    }

    // MARK: Mapping

    private static func item(
        from d: [String: Any], path: String, source: String
    ) -> DiagnosticItem? {
        guard let message = d["message"] as? String, !message.isEmpty else { return nil }
        let range = d["range"] as? [String: Any]
        let start = range?["start"] as? [String: Any]
        let line = start?["line"] as? Int ?? 0
        let character = start?["character"] as? Int ?? 0
        let severity = DiagnosticItem.Severity(
            rawValue: LSPSeverity.name(d["severity"] as? Int)
        ) ?? .error
        return DiagnosticItem(
            severity: severity,
            message: message,
            filePath: path,
            // LSP is zero-based; every human-facing surface here is
            // one-based. Converted in exactly one place (LSPPosition).
            line: LSPPosition.toDisplayLine(line),
            col: LSPPosition.toDisplayColumn(character),
            source: source
        )
    }

    /// `file://` URIs with percent-encoding — a path containing a space or
    /// a `#` is not optional to handle, it is the default on macOS.
    static func fileURI(_ path: String) -> String {
        URL(fileURLWithPath: path).absoluteString
    }

    static func path(fromURI uri: String) -> String {
        URL(string: uri)?.path ?? uri
    }
}
