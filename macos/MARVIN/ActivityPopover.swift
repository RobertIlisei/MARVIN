// ActivityPopover — the live "what is MARVIN doing in the background"
// surface. Until 2026-07-03 scheduled wakeups (ADR-0031) and running
// background jobs (ADR-0038) were visible only to the MODEL (MCP
// tools); the UI could learn a job finished but never see or cancel
// in-flight work. Backed by the new GET/DELETE /api/wakeups and
// /api/background-jobs routes, plus the (previously never-consumed)
// GET /api/audit/auto tail of auto-allowed mutations.

import SwiftUI

struct ActivityPopover: View {
    let projectId: String?
    let sessionId: String?
    let workDir: String?

    @State private var wakeups: [WakeupSummary] = []
    @State private var jobs: [JobSummary] = []
    @State private var auditEntries: [AuditEntry] = []
    @State private var error: String?
    @State private var loading = true

    struct WakeupSummary: Codable, Identifiable {
        let id: String
        let reason: String
        let fireAt: Double   // epoch ms
        let deferrals: Int?
        var fireDate: Date { Date(timeIntervalSince1970: fireAt / 1000) }
    }
    struct JobSummary: Codable, Identifiable {
        let id: String
        let command: String
        let reason: String
        let pid: Int
        let startedAt: String
    }
    struct AuditEntry: Codable, Identifiable {
        let at: String
        let tool: String
        let descriptor: String
        var id: String { at + descriptor }
    }

    /// What a confirmed stop will do, captured at confirm time so the alert
    /// and the action cannot disagree about the scope.
    struct StopPlan: Identifiable {
        let id = UUID()
        let summary: String
        let terminalRunning: Bool
    }

    @State private var pendingStop: StopPlan? = nil
    @State private var stopping = false
    @State private var stopReport: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Activity").font(.system(size: 12, weight: .semibold))
                Spacer()
                Button {
                    Task { await refresh() }
                } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if loading && wakeups.isEmpty && jobs.isEmpty {
                ProgressView().controlSize(.small)
            } else {
                jobsSection
                wakeupsSection
                auditSection
            }
            MarvinDivider()
            stopEverythingButton
        }
        .padding(12)
        .frame(width: 380)
        .task { await refresh() }
        // Confirmation names the scope. "Stop everything?" is a question a
        // user cannot answer — they do not know what everything is, and one
        // of the things in it might be a forty-minute build they forgot was
        // running. The alert lists the count of each kind before anything
        // dies.
        .alert(
            "Stop this session?",
            isPresented: Binding(
                get: { pendingStop != nil },
                set: { if !$0 { pendingStop = nil } }
            ),
            presenting: pendingStop
        ) { plan in
            Button("Stop Everything", role: .destructive) {
                let confirmed = plan
                pendingStop = nil
                Task { await performStop(confirmed) }
            }
            Button("Cancel", role: .cancel) { pendingStop = nil }
        } message: { plan in
            Text("This will stop \(plan.summary).\n\nBackground jobs are killed, scheduled wakeups are cancelled so they cannot start a new turn later, and the running turn is aborted. This cannot be undone.")
        }
    }

    /// The one control that stops a session and everything it left running.
    ///
    /// It lives HERE, in the popover that lists the background jobs and the
    /// scheduled wakeups, because this is where a user can already see what
    /// is running — a stop button somewhere else would be asking them to
    /// confirm a list they are not looking at. It is also in the Run menu and
    /// the ⇧⌘P palette, via `CommandRegistry`.
    @ViewBuilder private var stopEverythingButton: some View {
        HStack {
            Button(role: .destructive) {
                Task { await beginStop() }
            } label: {
                Label(
                    stopping ? "Stopping…" : "Stop Session & All Work",
                    systemImage: "stop.circle"
                )
                .font(.system(size: 11, weight: .medium))
            }
            .disabled(stopping || sessionId == nil)
            Spacer()
        }
        if let stopReport {
            Text(stopReport)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Ask the server what is running, then confirm against THAT — not
    /// against the popover's own lists, which may be a refresh behind.
    private func beginStop() async {
        guard let sessionId else { return }
        stopReport = nil
        guard let scope = await SessionStopService.preview(
            sessionId: sessionId, projectId: projectId
        ) else {
            error = "Could not read what is running."
            return
        }
        // Terminal shells are the user's own processes, not MARVIN's, so they
        // are named separately rather than folded into "background jobs" —
        // and only when one is actually running.
        //
        // Scoped to THIS project's workDir. Several sessions can be live at
        // once, each on its own project, and stopping one of them must not
        // reach into another's terminal (user, 2026-08-31: "we only need to
        // kill the session we want with it's adiacents, not the rest of the
        // sessions or their jobs"). Everything else here is already filtered
        // by `marvinSessionId` server-side; this was the one global.
        let terminalRunning = workDir.map {
            TerminalSessionStore.shared.isRunning(workDir: $0)
        } ?? false
        var parts: [String] = []
        if let summary = scope.summary { parts.append(summary) }
        if terminalRunning { parts.append("this project's terminal session") }
        guard !parts.isEmpty else {
            stopReport = "Nothing is running."
            return
        }
        let joined = parts.count == 1
            ? parts[0]
            : parts.dropLast().joined(separator: ", ") + " and " + (parts.last ?? "")
        pendingStop = StopPlan(summary: joined, terminalRunning: terminalRunning)
    }

    private func performStop(_ plan: StopPlan) async {
        guard let sessionId else { return }
        stopping = true
        defer { stopping = false }
        let result = await SessionStopService.stop(sessionId: sessionId, projectId: projectId)
        // Terminals are client-side: the sidecar never had a handle on them.
        // One workDir, not all of them — see `beginStop`.
        if plan.terminalRunning, let workDir {
            TerminalSessionStore.shared.terminate(workDir: workDir)
        }
        guard let result else {
            error = "Stop failed."
            return
        }
        var bits: [String] = []
        if result.turnCancelled { bits.append("turn aborted") }
        if result.jobsCancelled > 0 { bits.append("\(result.jobsCancelled) job(s) killed") }
        if result.wakeupsCancelled > 0 { bits.append("\(result.wakeupsCancelled) wakeup(s) cancelled") }
        if plan.terminalRunning { bits.append("terminal closed") }
        if !result.failed.isEmpty { bits.append("\(result.failed.count) already gone") }
        stopReport = bits.isEmpty ? "Nothing was running." : "Stopped: " + bits.joined(separator: ", ") + "."
        await refresh()
    }

    @ViewBuilder private var jobsSection: some View {
        sectionHeader("Background jobs", count: jobs.count, icon: "gearshape.2")
        if jobs.isEmpty {
            emptyLine("No background jobs running.")
        } else {
            ForEach(jobs) { job in
                HStack(alignment: .top, spacing: 6) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(job.reason.isEmpty ? job.command : job.reason)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1)
                        Text("\(job.command) · pid \(job.pid)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Button("Stop") { Task { await cancelJob(job.id) } }
                        .controlSize(.mini)
                }
            }
        }
    }

    @ViewBuilder private var wakeupsSection: some View {
        sectionHeader("Scheduled wakeups", count: wakeups.count, icon: "alarm")
        if wakeups.isEmpty {
            emptyLine("Nothing scheduled.")
        } else {
            ForEach(wakeups) { w in
                HStack(alignment: .top, spacing: 6) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(w.reason)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(2)
                        Text("fires \(w.fireDate.formatted(.relative(presentation: .named)))\((w.deferrals ?? 0) > 0 ? " · deferred \(w.deferrals!)×" : "")")
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Cancel") { Task { await cancelWakeup(w.id) } }
                        .controlSize(.mini)
                }
            }
        }
    }

    @ViewBuilder private var auditSection: some View {
        sectionHeader("Recent auto-allowed mutations", count: auditEntries.count, icon: "checkmark.shield")
        if auditEntries.isEmpty {
            emptyLine("No auto-audit entries.")
        } else {
            ForEach(auditEntries.prefix(8)) { e in
                HStack(spacing: 6) {
                    Text(e.tool)
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 3))
                    Text(e.descriptor)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer()
                    Text(String(e.at.dropFirst(11).prefix(5)))
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private func sectionHeader(_ title: String, count: Int, icon: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 10)).foregroundStyle(.secondary)
            Text(title).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
            if count > 0 {
                Text("\(count)")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 2)
    }

    private func emptyLine(_ s: String) -> some View {
        Text(s).font(.system(size: 10)).foregroundStyle(.tertiary)
    }

    // MARK: - Networking

    private func refresh() async {
        loading = true; defer { loading = false }
        error = nil
        async let w: [WakeupSummary] = fetchWakeups()
        async let j: [JobSummary] = fetchJobs()
        async let a: [AuditEntry] = fetchAudit()
        wakeups = await w
        jobs = await j
        auditEntries = await a
    }

    private func fetchWakeups() async -> [WakeupSummary] {
        struct Wire: Codable { let wakeups: [WakeupSummary] }
        var query = ""
        if let projectId { query = "?projectId=\(projectId)" }
        guard let url = URL(string: "\(ServerConfig.baseURLString)/api/wakeups\(query)"),
              let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let wire = try? JSONDecoder().decode(Wire.self, from: data)
        else { return [] }
        return wire.wakeups
    }

    private func fetchJobs() async -> [JobSummary] {
        struct Wire: Codable { let jobs: [JobSummary] }
        var query = ""
        if let sessionId { query = "?sessionId=\(sessionId)" }
        guard let url = URL(string: "\(ServerConfig.baseURLString)/api/background-jobs\(query)"),
              let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let wire = try? JSONDecoder().decode(Wire.self, from: data)
        else { return [] }
        return wire.jobs
    }

    private func fetchAudit() async -> [AuditEntry] {
        struct Wire: Codable { let entries: [AuditEntry] }
        guard let workDir,
              let encoded = workDir.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(ServerConfig.baseURLString)/api/audit/auto?cwd=\(encoded)&limit=20"),
              let (data, resp) = try? await URLSession.shared.data(from: url),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let wire = try? JSONDecoder().decode(Wire.self, from: data)
        else { return [] }
        return wire.entries
    }

    private func cancelWakeup(_ id: String) async {
        await deleteCall(path: "api/wakeups", id: id, extra: projectId.map { ("projectId", $0) })
    }

    private func cancelJob(_ id: String) async {
        await deleteCall(path: "api/background-jobs", id: id, extra: nil)
    }

    private func deleteCall(path: String, id: String, extra: (String, String)?) async {
        var comps = URLComponents(string: "\(ServerConfig.baseURLString)/\(path)")!
        comps.queryItems = [URLQueryItem(name: "id", value: id)]
        if let extra { comps.queryItems?.append(URLQueryItem(name: extra.0, value: extra.1)) }
        guard let url = comps.url else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        req.setValue("1", forHTTPHeaderField: "x-marvin-client")
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                error = "Cancel failed."
                return
            }
            await refresh()
        } catch {
            self.error = "Cancel failed: \(error.localizedDescription)"
        }
    }
}
