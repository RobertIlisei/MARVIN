// AuthSettingsSection — UI for choosing between Claude CLI host
// credentials and a direct Anthropic API key.
//
// Backed by the sidecar's GET / POST / DELETE /api/auth/config which
// stores the choice (and the optional API key) at
// `~/.marvin/auth-config.json` with `0600`.
//
// Resolution precedence (in `sidecar/packages/runtime/src/auth.ts`):
//   1. file: mode=api-key + key   →  use that key
//   2. file: mode=cli             →  force host-credentials, ignore env
//   3. no file (default)          →  ANTHROPIC_API_KEY env, then host
//
// The raw key never leaves this view — POST sends it once, every GET
// gets the masked `keyHint` (last 4 chars only). On save the field is
// cleared so a stale draft can't sit in memory.

import SwiftUI

private struct AuthConfigStatus: Decodable {
    let config: ConfigBody
    let effective: EffectiveBody

    struct ConfigBody: Decodable {
        let mode: String?       // "cli" | "api-key" | null (no file)
        let keyHint: String?    // "…wxyz" | null
        let savedAt: String?    // ISO timestamp | null
    }

    struct EffectiveBody: Decodable {
        let mode: String        // "host-credentials" | "api-key" | "oauth" | "none"
        let credentialHint: String?
        let error: String?
    }
}

struct AuthSettingsSection: View {
    @State private var status: AuthConfigStatus?
    @State private var draftMode: String = "cli"      // local picker state
    @State private var draftKey: String = ""          // SecureField draft
    @State private var inFlight: Bool = false
    @State private var lastError: String?

    var body: some View {
        Section("Authentication") {
            Picker("Mode", selection: $draftMode) {
                Text("Claude CLI (default)").tag("cli")
                Text("Anthropic API key").tag("api-key")
            }
            .pickerStyle(.inline)
            .disabled(inFlight)
            .onChange(of: draftMode) { _, _ in
                lastError = nil
                if draftMode == "cli" {
                    // Picking "Claude CLI" is a one-click save — no key
                    // to type — so apply immediately.
                    Task { await save(mode: "cli", key: nil) }
                }
            }

            if draftMode == "api-key" {
                LabeledContent("API key") {
                    HStack(spacing: 8) {
                        SecureField("sk-ant-…", text: $draftKey)
                            .textFieldStyle(.roundedBorder)
                            .disabled(inFlight)
                        Button("Save") {
                            Task { await save(mode: "api-key", key: draftKey) }
                        }
                        .disabled(inFlight || draftKey.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }

            if let s = status {
                LabeledContent("Effective") {
                    Text(effectiveLabel(s.effective))
                        .font(.body.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                if s.config.mode != nil {
                    HStack {
                        if let savedAt = s.config.savedAt {
                            Text("Saved \(savedAt)")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        Button("Reset to default") {
                            Task { await clear() }
                        }
                        .disabled(inFlight)
                        .help("Removes ~/.marvin/auth-config.json and falls back to host-credentials.")
                    }
                }
            }

            if let err = lastError {
                Text(err)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Text("Default is the Claude CLI session (auto-detected from ~/.claude). Pick \"Anthropic API key\" only if you want every chat turn billed against a specific Console key.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .task { await refresh() }
    }

    // MARK: - Networking

    private func endpoint() -> URL {
        ServerConfig.baseURL.appendingPathComponent("api/auth/config")
    }

    private func refresh() async {
        do {
            var req = URLRequest(url: endpoint())
            req.cachePolicy = .reloadIgnoringLocalCacheData
            let (data, _) = try await URLSession.shared.data(for: req)
            let next = try JSONDecoder().decode(AuthConfigStatus.self, from: data)
            await MainActor.run {
                self.status = next
                // Sync the picker to whatever the file says, falling back
                // to "cli" when no file exists (today's default).
                self.draftMode = next.config.mode ?? "cli"
            }
        } catch {
            await MainActor.run { self.lastError = "Failed to load auth config: \(error.localizedDescription)" }
        }
    }

    private func save(mode: String, key: String?) async {
        await MainActor.run {
            self.inFlight = true
            self.lastError = nil
        }
        defer { Task { @MainActor in self.inFlight = false } }

        var req = URLRequest(url: endpoint())
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        var body: [String: String] = ["mode": mode]
        if let k = key?.trimmingCharacters(in: .whitespaces), !k.isEmpty {
            body["apiKey"] = k
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                let msg = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
                await MainActor.run { self.lastError = msg }
                return
            }
            let next = try JSONDecoder().decode(AuthConfigStatus.self, from: data)
            await MainActor.run {
                self.status = next
                // Clear the SecureField draft so a stale key can't sit
                // around. The user's choice is now persisted; if they
                // need to update the key later, they re-enter it.
                self.draftKey = ""
            }
        } catch {
            await MainActor.run { self.lastError = "Save failed: \(error.localizedDescription)" }
        }
    }

    private func clear() async {
        await MainActor.run {
            self.inFlight = true
            self.lastError = nil
        }
        defer { Task { @MainActor in self.inFlight = false } }

        var req = URLRequest(url: endpoint())
        req.httpMethod = "DELETE"
        req.setValue("1", forHTTPHeaderField: "X-Marvin-Client")
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, http.statusCode >= 400 {
                let msg = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
                await MainActor.run { self.lastError = msg }
                return
            }
            let next = try JSONDecoder().decode(AuthConfigStatus.self, from: data)
            await MainActor.run {
                self.status = next
                self.draftMode = next.config.mode ?? "cli"
                self.draftKey = ""
            }
        } catch {
            await MainActor.run { self.lastError = "Clear failed: \(error.localizedDescription)" }
        }
    }

    private func effectiveLabel(_ e: AuthConfigStatus.EffectiveBody) -> String {
        switch e.mode {
        case "host-credentials":
            return e.credentialHint ?? "host-credentials"
        case "api-key":
            return "API key · \(e.credentialHint ?? "")"
        case "oauth":
            return "OAuth · \(e.credentialHint ?? "")"
        case "none":
            return e.error ?? "no credentials"
        default:
            return e.mode
        }
    }
}
