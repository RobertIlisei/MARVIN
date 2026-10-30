// SurfaceSnapshotSidecar — a stand-in sidecar for the offscreen surface
// snapshot harness (SurfaceSnapshot.swift). Dev-only; nothing in the app reads it.
//
// The panes load their content from the sidecar over loopback HTTP, through
// services that each own a URLSession. Rather than mock those services (or
// give views a fixture initializer), the harness answers the same requests the
// real sidecar would, from SurfaceFixtures, on `ServerConfig.port`. Every view
// is then mounted exactly as it ships and decodes the same JSON it decodes in
// use. It binds loopback only, and the harness refuses port 3030, so it can
// never stand in for — or collide with — a live sidecar.

import Foundation
import Network

final class FixtureSidecar: @unchecked Sendable {
    struct Response {
        var status = 200
        var contentType = "application/json"
        var body = Data()
        /// Answer with the headers and then keep the connection open — an SSE
        /// endpoint that has nothing to say, as opposed to one that failed.
        var hold = false

        static func json(_ text: String, status: Int = 200) -> Response {
            Response(status: status, body: Data(text.utf8))
        }

        static func html(_ text: String) -> Response {
            Response(contentType: "text/html; charset=utf-8", body: Data(text.utf8))
        }

        static func stream() -> Response {
            Response(contentType: "text/event-stream", hold: true)
        }

        static func missing() -> Response {
            Response(status: 404, body: Data(#"{"error":"not in the fixture set"}"#.utf8))
        }
    }

    typealias Handler = @Sendable (_ method: String, _ path: String, _ query: [String: String]) -> Response

    private let listener: NWListener
    private let queue = DispatchQueue(label: "marvin.snapshot.sidecar")
    private let handler: Handler
    private var held: [NWConnection] = []
    private var unhandled: Set<String> = []

    init?(port: Int, handler: @escaping Handler) {
        guard let p = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return nil }
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        guard let listener = try? NWListener(using: params, on: p) else { return nil }
        self.listener = listener
        self.handler = handler
    }

    /// Bind and wait for the listener to be ready. False when the port is
    /// taken or privileged (MARVIN_PORT=1 cannot bind).
    func start() -> Bool {
        let ready = DispatchSemaphore(value: 0)
        let state = LockedFlag()
        listener.stateUpdateHandler = { s in
            switch s {
            case .ready: state.set(true); ready.signal()
            case .failed, .cancelled: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 3)
        return state.value
    }

    func stop() {
        listener.cancel()
        queue.sync { held.forEach { $0.cancel() }; held.removeAll() }
    }

    // MARK: - Connections

    private func accept(_ conn: NWConnection) {
        conn.start(queue: queue)
        read(conn, buffer: Data())
    }

    private func read(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if buf.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(conn, request: buf)
            } else if isComplete || error != nil {
                conn.cancel()
            } else {
                self.read(conn, buffer: buf)
            }
        }
    }

    private func respond(_ conn: NWConnection, request: Data) {
        let head = String(decoding: request, as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
        let parts = head.split(separator: " ")
        guard parts.count >= 2 else { conn.cancel(); return }
        let method = String(parts[0])
        let comps = URLComponents(string: String(parts[1]))
        let path = comps?.path ?? String(parts[1])
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }

        let response = handler(method, path, query)
        if response.status == 404, unhandled.insert("\(method) \(path)").inserted {
            FileHandle.standardError.write(Data("fixture sidecar: no fixture for \(method) \(path)\n".utf8))
        }
        let reason = response.status == 200 ? "OK" : (response.status == 404 ? "Not Found" : "Status")
        var header = "HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: \(response.contentType)\r\n"
        header += "Cache-Control: no-store\r\n"
        if response.hold {
            header += "Connection: keep-alive\r\n\r\n"
            held.append(conn)
            // Whatever the stream has to say goes out with the headers; the
            // connection then stays open and silent.
            var out = Data(header.utf8)
            out.append(response.body)
            conn.send(content: out, completion: .contentProcessed { _ in })
            return
        }
        header += "Content-Length: \(response.body.count)\r\nConnection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(response.body)
        conn.send(content: out, contentContext: .finalMessage, isComplete: true,
                  completion: .contentProcessed { _ in conn.cancel() })
    }
}

/// A flag written on the listener's queue and read once on the caller's.
private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set(_ v: Bool) { lock.lock(); flag = v; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}
