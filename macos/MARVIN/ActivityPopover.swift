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
        }
        .padding(12)
        .frame(width: 380)
        .task { await refresh() }
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
