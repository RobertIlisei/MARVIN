// OnboardingView — first-launch experience for new MARVIN users.
//
// Shown ONCE, the very first time MARVIN opens after install (or after
// `Help → Show Onboarding` is invoked manually). State lives in
// `NativePrefs.hasCompletedOnboarding`.
//
// Replaces the WelcomeView at first launch so a stranger who just ran
// `brew install --cask marvin-ai` lands somewhere that answers the
// three questions every new user has:
//
//   1. What is this thing? (one paragraph, no marketing.)
//   2. Do I need an API key? (auto-detect via /api/health, show what
//      we found, offer setup if missing.)
//   3. How do I start? (a "Pick a project" button that drops them at
//      the existing WelcomeView once dismissed.)
//
// Two-step flow:
//   Welcome  → identity + one-paragraph product framing + Continue
//   Setup    → credential status banner + inline auth setup + Get started
//
// "Get started" flips `hasCompletedOnboarding` and the underlying
// WelcomeView re-renders so the user can pick their first project.

import SwiftUI

struct OnboardingView: View {
    @State private var step: Step = .welcome
    @State private var credentialStatus: CredentialStatus = .checking

    private enum Step { case welcome, setup }

    private enum CredentialStatus: Equatable {
        case checking
        case detected(String)       // mode label e.g. "Claude CLI" / "API key"
        case missing
    }

    var body: some View {
        ZStack {
            // Reuse the WelcomeView's identity panel as the left side,
            // step content on the right. Same split, different right
            // pane content per step.
            HStack(spacing: 0) {
                identityPanel
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(nsColor: .controlBackgroundColor))

                Divider()

                stepContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(nsColor: .windowBackgroundColor))
            }
        }
        .frame(minWidth: 720, minHeight: 480)
        .task { await refreshCredentialStatus() }
    }

    // MARK: - Identity panel (matches WelcomeView's left column)

    private var identityPanel: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "brain.head.profile")
                .font(.system(size: 64, weight: .ultraLight))
                .foregroundStyle(.secondary)
                .symbolRenderingMode(.hierarchical)

            VStack(spacing: 4) {
                Text("MARVIN")
                    .font(.system(size: 36, weight: .bold, design: .monospaced))
                    .tracking(4)
                Text("Moderately Advanced Robotic\nVirtual Intelligence Network")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }

            // Stepper dots under the wordmark — gentle visual cue
            // that there's more than one screen.
            HStack(spacing: 8) {
                Circle()
                    .fill(step == .welcome ? Color.accentColor : Color.secondary.opacity(0.3))
                    .frame(width: 8, height: 8)
                Circle()
                    .fill(step == .setup ? Color.accentColor : Color.secondary.opacity(0.3))
                    .frame(width: 8, height: 8)
            }
            .padding(.top, 8)

            Spacer()
        }
        .padding(32)
    }

    // MARK: - Step routing

    @ViewBuilder
    private var stepContent: some View {
        switch step {
        case .welcome: welcomeStep
        case .setup:   setupStep
        }
    }

    // MARK: - Step 1: welcome

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 20) {
                Text("Welcome")
                    .font(.system(size: 28, weight: .semibold))

                Text("MARVIN is a pair-programming assistant for your Mac. You tell it what you want to build; it reads the code, proposes a plan, edits files with explicit confirmations, runs the tests, and commits.")
                    .font(.body)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                Text("It works on any project you point it at — Swift, TypeScript, Python, Go, Rust, whatever. The chat sits on the right; the files, source control, and a built-in terminal sit on the left. Memory and ADRs persist across sessions in your project's `.marvin/` directory.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                bullet("Powered by Claude — bring your own credentials (Claude Pro via `claude login`, or an Anthropic API key).")
                bullet("Local-first. Your code never leaves your machine except via the model API call MARVIN makes on your behalf.")
                bullet("Every edit, every commit, every shell command is shown before it runs.")
            }
            .padding(40)

            Spacer()
            Divider()
            HStack {
                Spacer()
                Button {
                    step = .setup
                    Task { await refreshCredentialStatus() }
                } label: {
                    Text("Continue").frame(minWidth: 100)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding(20)
        }
    }

    // MARK: - Step 2: setup

    private var setupStep: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 20) {
                Text("Authentication")
                    .font(.system(size: 28, weight: .semibold))

                Text("MARVIN needs Anthropic credentials to talk to Claude. Easiest path is to log in with the Claude CLI you may already have; an Anthropic API key works too.")
                    .font(.body)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)

                credentialBanner

                if credentialStatus == .missing {
                    setupHelp
                }

                Text("You can change this any time in **Settings → Authentication**.")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 8)
            }
            .padding(40)

            Spacer()
            Divider()
            HStack {
                Button("Back") { step = .welcome }
                    .buttonStyle(.bordered)

                Spacer()

                Button {
                    complete()
                } label: {
                    Text(credentialStatus == .missing ? "Skip for now" : "Get started")
                        .frame(minWidth: 120)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .padding(20)
        }
    }

    @ViewBuilder
    private var credentialBanner: some View {
        switch credentialStatus {
        case .checking:
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Checking credentials…").foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .detected(let label):
            HStack(spacing: 10) {
                Image(systemName: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Credentials detected")
                        .fontWeight(.medium)
                    Text(label)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh") {
                    Task { await refreshCredentialStatus() }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.green.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))

        case .missing:
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text("No credentials yet")
                        .fontWeight(.medium)
                    Text("MARVIN will boot but every chat turn will fail until you set this up.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Refresh") {
                    Task { await refreshCredentialStatus() }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var setupHelp: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pick one:")
                .font(.callout.weight(.medium))
                .padding(.top, 8)

            VStack(alignment: .leading, spacing: 6) {
                Text("• **Claude CLI (free with Claude Pro)** — open Terminal and run:")
                Text("`brew install claude-code && claude login`")
                    .font(.system(.callout, design: .monospaced))
                    .padding(8)
                    .background(Color(nsColor: .controlBackgroundColor))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Text("Once you've finished, click **Refresh** above.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("• **Anthropic API key (pay-as-you-go)** — paste it into Settings → Authentication.")
                Text("Open Settings with ⌘, after Get started.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Helpers

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "circle.fill")
                .font(.system(size: 5))
                .foregroundStyle(.tertiary)
                .padding(.top, 7)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func refreshCredentialStatus() async {
        await MainActor.run { self.credentialStatus = .checking }
        var req = URLRequest(url: ServerConfig.baseURL.appendingPathComponent("api/health"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            // Health shape: { ok, auth: { mode, ...} }
            // mode ∈ "host-credentials" | "api-key" | "oauth" | "none"
            struct H: Decodable {
                let auth: Auth?
                struct Auth: Decodable { let mode: String? }
            }
            let parsed = try? JSONDecoder().decode(H.self, from: data)
            let mode = parsed?.auth?.mode ?? "none"
            let label: String
            switch mode {
            case "host-credentials": label = "Claude CLI session (~/.claude)"
            case "oauth":            label = "Claude OAuth token"
            case "api-key":          label = "Anthropic API key"
            default:                 label = ""
            }
            await MainActor.run {
                self.credentialStatus = label.isEmpty ? .missing : .detected(label)
            }
        } catch {
            await MainActor.run { self.credentialStatus = .missing }
        }
    }

    private func complete() {
        NativePrefs.shared.markOnboardingComplete()
    }
}
