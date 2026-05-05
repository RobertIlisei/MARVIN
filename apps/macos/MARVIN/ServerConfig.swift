// ServerConfig — single source of truth for the sidecar base URL.
//
// All HTTP clients in the app read from here. Never hardcode
// "http://localhost:3030" in service or view files.
//
// MARVIN_PORT is set in the launchd plist at install time, so the
// system agent and the Swift app always agree on the same port without
// a rebuild. Default is 3030 when the env var is absent (dev loop).

import Foundation

enum ServerConfig {
    /// Port the Next.js sidecar listens on.
    /// Reads MARVIN_PORT from the process environment; falls back to 3030.
    static let port: Int = {
        if let raw = ProcessInfo.processInfo.environment["MARVIN_PORT"],
           let n = Int(raw), n > 0 { return n }
        return 3030
    }()

    /// Base URL for all loopback requests (no trailing slash).
    static let baseURL: URL = URL(string: "http://localhost:\(port)")!

    /// String form — for display labels and tooltips.
    static let baseURLString: String = baseURL.absoluteString
}
