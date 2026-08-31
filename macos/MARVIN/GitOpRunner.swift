// GitOpRunner — one place for the guarded-git-mutation dance.
//
// Every mutating route in `/api/git/*` can answer `409 needs-confirm`
// with a policy decision + an op echo. Resolving that means: show the
// user the reason, mint a one-shot token at `/api/git/confirm`, then
// re-issue the SAME request with an `X-Marvin-Confirmed` header
// (ADR-0012). Three surfaces now need that — the SCM panel, the branch
// picker, and the status bar's sync control — and the flow has enough
// moving parts that copying it three times would guarantee three
// slightly different versions.
//
// ## The shape that makes the retry trivial
//
// The body closure takes the token as a parameter:
//
//     run(verb: "discard", key: path) { token in
//         try await FilesService.shared.discard(…, confirmToken: token)
//     }
//
// so the retry is literally "call it again with the token". The first
// version of this logic (inline in SourceControlView) stored a
// token-LESS closure and rebuilt each request by hand in a
// `switch verb`, which meant every new confirm-class op had to be
// added there too — and the `default:` branch logged and returned,
// silently swallowing the user's confirmation. Passing the token in
// removes the switch and that whole class of bug with it.
//
// The runner is deliberately NOT a singleton: each panel owns one, so
// an in-flight branch switch can't dim the SCM panel's commit button.

import SwiftUI

@MainActor
@Observable
final class GitOpRunner {
    /// Keys of the ops currently in flight, e.g. `"discard:src/a.ts"`.
    /// Callers use these to drive per-row spinners; the key is theirs
    /// to choose, the runner only guarantees uniqueness while running.
    private(set) var inFlight: Set<String> = []

    /// Last terminal failure. Set on throw or on a confirm loop that
    /// didn't resolve; cleared when a new op starts.
    var lastError: String? = nil

    /// Last success note — git's own stderr summary for remote ops
    /// ("To github.com/…"). Nil for local ops, which have nothing
    /// interesting to say when they work.
    var lastNote: String? = nil

    /// Non-nil while a confirm sheet should be on screen.
    var pendingConfirm: PendingGitConfirm? = nil

    /// Called after any op completes successfully — the host wires
    /// this to its refresh. Set once at construction site.
    var onDidMutate: (() -> Void)? = nil

    func isRunning(_ key: String) -> Bool { inFlight.contains(key) }
    var isBusy: Bool { !inFlight.isEmpty }

    func dismissError() { lastError = nil }
    func dismissNote() { lastNote = nil }

    /// Run a guarded mutation. `body` MUST forward `token` to the
    /// service call's `confirmToken:` parameter — that is what makes
    /// the confirm round-trip work.
    ///
    /// `cwd` is captured for the token mint, which binds the token to
    /// a working directory as well as to the op.
    func run(
        verb: String,
        key: String,
        cwd: String,
        body: @escaping (_ token: String?) async throws -> FilesService.GitMutationOutcome,
        onSuccess: (() -> Void)? = nil
    ) {
        let opKey = key.isEmpty ? verb : "\(verb):\(key)"
        guard !inFlight.contains(opKey) else { return }
        inFlight.insert(opKey)
        lastError = nil
        Task { @MainActor in
            defer { inFlight.remove(opKey) }
            await execute(
                verb: verb,
                cwd: cwd,
                token: nil,
                body: body,
                onSuccess: onSuccess
            )
        }
    }

    /// Remote variant — same flow, but the outcome carries git's note.
    func runRemote(
        verb: String,
        cwd: String,
        body: @escaping (_ token: String?) async throws -> FilesService.GitRemoteOutcome,
        onSuccess: (() -> Void)? = nil
    ) {
        guard !inFlight.contains(verb) else { return }
        inFlight.insert(verb)
        lastError = nil
        lastNote = nil
        Task { @MainActor in
            defer { inFlight.remove(verb) }
            await executeRemote(
                verb: verb,
                cwd: cwd,
                token: nil,
                body: body,
                onSuccess: onSuccess
            )
        }
    }

    /// Await a remote op inline. Used by "Sync" and "Commit & Push",
    /// which are two ops that must happen IN ORDER — firing both
    /// through `runRemote` would race, and pushing before the pull
    /// landed is exactly the failure the sync button exists to avoid.
    /// Returns `true` when the op succeeded.
    @discardableResult
    func runRemoteAwaiting(
        verb: String,
        cwd: String,
        body: @escaping (_ token: String?) async throws -> FilesService.GitRemoteOutcome
    ) async -> Bool {
        guard !inFlight.contains(verb) else { return false }
        inFlight.insert(verb)
        defer { inFlight.remove(verb) }
        return await executeRemote(verb: verb, cwd: cwd, token: nil, body: body)
    }

    // MARK: - Internals

    @discardableResult
    private func execute(
        verb: String,
        cwd: String,
        token: String?,
        body: @escaping (_ token: String?) async throws -> FilesService.GitMutationOutcome,
        onSuccess: (() -> Void)?
    ) async -> Bool {
        do {
            switch try await body(token) {
            case .ok:
                onSuccess?()
                onDidMutate?()
                return true
            case .needsConfirm(let severity, let reason, let op):
                if token != nil {
                    // We already spent a token on this exact op and the
                    // gate still refuses. Something moved under us —
                    // report it rather than minting forever.
                    lastError = "\(verb): still needs confirmation after a token was minted"
                    return false
                }
                await confirmThenRetry(
                    verb: verb,
                    cwd: cwd,
                    severity: severity,
                    reason: reason,
                    op: op
                ) { [weak self] minted in
                    await self?.execute(
                        verb: verb,
                        cwd: cwd,
                        token: minted,
                        body: body,
                        onSuccess: onSuccess
                    )
                }
                return false
            }
        } catch {
            lastError = "\(verb) failed: \(describe(error))"
            return false
        }
    }

    @discardableResult
    private func executeRemote(
        verb: String,
        cwd: String,
        token: String?,
        body: @escaping (_ token: String?) async throws -> FilesService.GitRemoteOutcome,
        onSuccess: (() -> Void)? = nil
    ) async -> Bool {
        do {
            switch try await body(token) {
            case .ok(let note):
                lastNote = note
                onSuccess?()
                onDidMutate?()
                return true
            case .needsConfirm(let severity, let reason, let op):
                if token != nil {
                    lastError = "\(verb): still needs confirmation after a token was minted"
                    return false
                }
                await confirmThenRetry(
                    verb: verb,
                    cwd: cwd,
                    severity: severity,
                    reason: reason,
                    op: op
                ) { [weak self] minted in
                    await self?.executeRemote(
                        verb: verb,
                        cwd: cwd,
                        token: minted,
                        body: body,
                        onSuccess: onSuccess
                    )
                }
                return false
            }
        } catch {
            lastError = "\(verb) failed: \(describe(error))"
            return false
        }
    }

    /// Park the op behind a confirm sheet. `retry` runs only if the
    /// user confirms AND the mint succeeds.
    private func confirmThenRetry(
        verb: String,
        cwd: String,
        severity: String,
        reason: String,
        op: ChatJSON,
        retry: @escaping (String) async -> Void
    ) async {
        pendingConfirm = PendingGitConfirm(
            actionVerb: verb.capitalized,
            reason: reason,
            severity: severity,
            paths: Self.pathsPreview(from: op),
            confirm: { [weak self] in
                guard let self else { return }
                self.pendingConfirm = nil
                Task { @MainActor in
                    do {
                        let minted = try await FilesService.shared
                            .mintGitConfirmToken(cwd: cwd, op: op)
                        await retry(minted.token)
                    } catch {
                        self.lastError = "Token mint failed: \(self.describe(error))"
                    }
                }
            },
            cancel: { [weak self] in self?.pendingConfirm = nil }
        )
    }

    /// Pull a `paths` array out of the op echo so the confirm sheet can
    /// name what is about to happen. Best-effort: ops without paths
    /// (branch switch, push) simply show none.
    private static func pathsPreview(from op: ChatJSON) -> [String] {
        guard case let .object(dict) = op,
              case let .array(items)? = dict["paths"] else { return [] }
        return items.compactMap {
            if case let .string(s) = $0 { return s } else { return nil }
        }
    }

    /// `FilesServiceError` prints as a Swift enum dump by default,
    /// which puts `httpStatus(409, body: Optional("…"))` in front of
    /// the user. Unwrap the parts that mean something.
    private func describe(_ error: Error) -> String {
        guard let e = error as? FilesServiceError else {
            return error.localizedDescription
        }
        switch e {
        case .httpStatus(let code, let body):
            let detail = (body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return detail.isEmpty ? "HTTP \(code)" : "HTTP \(code) — \(detail)"
        case .decode:
            return "unexpected response shape"
        case .transport(let underlying):
            return underlying.localizedDescription
        }
    }
}

/// Pending guarded mutation — drives the GitConfirmSheet. The
/// closures bind to the model's retry/cancel paths so the sheet
/// itself stays state-free.
struct PendingGitConfirm: Identifiable {
    let id = UUID()
    let actionVerb: String
    let reason: String
    let severity: String
    let paths: [String]
    let confirm: () -> Void
    let cancel: () -> Void
}
