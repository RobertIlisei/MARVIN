// TerminalEnvironment — the environment a user's interactive shell is
// spawned with (ADR-0078).
//
// Mirrors `SCRUB_EXACT` in the retired `/api/terminal/run` route: the app
// process carries MARVIN's own credentials for the Claude CLI subprocess,
// and a shell the USER types into must not inherit them — `printenv` would
// echo every secret back into scrollback, and an `npm install` postinstall
// could read them. Everything else the user set (NPM_TOKEN, GH_TOKEN, …)
// is preserved: this strips what MARVIN injects, not what the user owns.
//
// Pure (ADR-0022): a dictionary in, a dictionary out.

import Foundation

public enum TerminalEnvironment {
    /// Names MARVIN itself injects, or well-known auth/telemetry names it
    /// may hold on the user's behalf. Never reach a user-typed shell.
    public static let scrubbed: Set<String> = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "HONEYCOMB_API_KEY",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "MARVIN_DATA_DIR",
        "MARVIN_APP_VERSION",
    ]

    /// Build the shell's environment from `source` (normally
    /// `ProcessInfo.processInfo.environment`).
    ///
    /// `TERM` / `COLORTERM` tell the shell it has a real colour terminal;
    /// `LANG` guarantees UTF-8 when the app was launched from Finder with an
    /// empty locale, which otherwise turns every non-ASCII glyph into `?`.
    /// `PATH` is prepended with the Homebrew + user-local bins for the same
    /// Finder-launch reason — a login shell fixes it too, but only after the
    /// user's rc files run, and a shell that cannot find `git` in the first
    /// second reads as broken.
    public static func make(
        from source: [String: String],
        columns: Int,
        rows: Int
    ) -> [String: String] {
        var env = source.filter { !scrubbed.contains($0.key) }
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        env["TERM_PROGRAM"] = "MARVIN"
        env["COLUMNS"] = String(columns)
        env["LINES"] = String(rows)
        if env["LANG"]?.isEmpty ?? true { env["LANG"] = "en_US.UTF-8" }
        let extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
            + (env["HOME"].map { ["\($0)/.local/bin"] } ?? [])
        let current = (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
        env["PATH"] = (extra.filter { !current.contains($0) } + current).joined(separator: ":")
        return env
    }

    /// The user's shell, as a login shell so their rc files run. `argv[0]`
    /// with a leading `-` is the POSIX convention that makes a shell treat
    /// itself as a login shell — zsh reads `.zprofile` + `.zshrc`, bash
    /// reads `.bash_profile`.
    public static func shell(from source: [String: String]) -> (path: String, argv0: String) {
        let path = source["SHELL"].flatMap { $0.isEmpty ? nil : $0 } ?? "/bin/zsh"
        let name = (path as NSString).lastPathComponent
        return (path, "-\(name)")
    }
}
