// ChatPreviewView — Phase 2b/c dev surface for the native chat.
//
// A separate Window scene hosting the native ChatInputBar +
// (Phase 2c) the structured message list. The main MARVIN window's
// WebView keeps rendering the existing web chat independently;
// Phase 2g promotes this content into the main window once the
// remaining sub-phases (cards, confirms, cancel/retry) reach
// parity.
//
// ## Why a separate window during 2b/c
//
//   1. Decoupled iteration. The main window's WebView is a working
//      surface the user actively uses. We don't want a half-built
//      native chat panel cluttering it while we're still figuring
//      out streaming render shapes.
//   2. Independent observation. The dev window can run alongside
//      the web chat in the main window, so we can A/B parity
//      between them — type the same message in both, watch the
//      same response stream into both surfaces.

import SwiftUI
import MARVINLogic

/// View-model for the preview window. Owns the text input, the
/// in-flight turn task, the rendered message list, and a terminal-
/// state surface for stream errors. Phase 2c — replaces 2b's
/// String-based event log with a structured ChatMessage list driven
/// by ChatStreamReducer.
/// Permission strategy values the sidecar accepts. Mirrors the
/// PermissionStrategy union in sidecar/src/app/api/chat/route.ts.
/// Phase 2g.1 — used by the native chat's send path; user picks
/// in Settings (defaults to .auto, the same as the web app's
/// out-of-the-box behaviour).
enum NativePermissionStrategy: String, CaseIterable, Identifiable {
    case auto
    case gated
    var id: String { rawValue }
}

@MainActor
@Observable
final class ChatPreviewModel {
    /// Editor text. Bound to ChatInputBar.
    var draft: String = ""

    /// Phase 5e — pre-send attachment chips (file mentions, image
    /// paste, selected snippets). Serialised into the message text
    /// on submit; the chip strip clears alongside the draft.
    var attachments: [ChatAttachment] = []

    /// True while a turn is in flight. Disables the editor + Send
    /// button so the user can't queue a second turn (the sidecar
    /// allows it, but the dev panel scope is one turn at a time;
    /// 2f will lift this when it adds proper stop / retry).
    var isSending: Bool = false

    /// The full message list rendered by the native chat view.
    /// Each user submit appends a user-side ChatMessage immediately
    /// (optimistic echo), then ChatStreamReducer mutates the list
    /// as cli.event payloads land.
    var messages: [ChatMessage] = []

    /// Last terminal failure for the most-recent turn, surfaced as
    /// a banner in the view. Cleared on next submit.
    var lastError: String? = nil

    /// Human-readable label for whatever MARVIN is doing right now.
    /// Driven from cli.event peeks: "Thinking…" while we wait for the
    /// model's first response, "Using Bash" / "Using Read" / etc. as
    /// each tool call arrives, "Writing reply…" when a plain text
    /// block lands. Replaces the static "Sending…" indicator so the
    /// user can see whether the agent is making progress instead of
    /// staring at an opaque spinner. Nil when idle.
    var currentActivity: String? = nil

    /// Messages the user typed while a turn was already in flight.
    /// Dispatched in order on `turn.completed` so the user can keep
    /// loading work onto the loop without waiting for each response —
    /// matches the queue affordance in the claude CLI. Each entry
    /// captures the cwd at queue time so a project switch in between
    /// doesn't redirect the queued message to the wrong workdir.
    var queuedMessages: [QueuedMessage] = []

    struct QueuedMessage: Identifiable, Equatable {
        let id = UUID()
        let text: String
        let cwd: String?
    }

    /// Pending confirm requests, oldest first. The view renders a
    /// sheet for the head of the queue; once the user decides, we
    /// remove it and the next one (if any) automatically presents.
    /// Phase 2e — a turn can fire several confirms in sequence
    /// (e.g. multiple Bash + Edit calls); queueing keeps the UX
    /// clean instead of stacking N modal sheets.
    var pendingConfirms: [ConfirmRequest] = []

    /// Set of toolUseIds the user has explicitly responded to in
    /// this preview session. Phase 2e doesn't surface "Allow always"
    /// (the API has no concept), but we track responded ids so the
    /// inline tool card can reflect "approved" / "denied" status
    /// without re-rendering the sheet on a duplicate event.
    var resolvedConfirms: [String: ChatService.ConfirmDecision] = [:]

    /// One-shot flag — when true, the next `send()` will pass
    /// `resetSdkSession: true` to the sidecar so the next turn starts
    /// with a fresh server-side SDK cache. The visible chat and the
    /// `marvinSessionId` are preserved. Cleared after the request is
    /// dispatched so the user has to opt in again per reset.
    /// ADR-0022 §3 follow-up.
    var resetSdkOnNextSend: Bool = false

    /// toolUseIds whose `respond(...)` Task is in flight. The confirm
    /// sheet's button handlers call `dismiss()` synchronously after
    /// kicking the async POST — that fires the parent's `isPresented`
    /// binding setter, which historically auto-denied the head of
    /// `pendingConfirms`. Net effect: every Allow click also POSTed a
    /// deny, and the deny usually landed at /api/confirm first → the
    /// SDK saw the call as denied. This set lets the setter skip the
    /// auto-deny when an explicit response is already racing for the
    /// same toolUseId. Esc / drag-dismiss without buttons still
    /// auto-denies (intended fallback for "user closed the sheet
    /// without choosing").
    var respondingToolUseIds: Set<String> = []

    /// The active marvinSessionId, captured from the most-recent
    /// turn.started event. Cancel uses this to address /api/chat/
    /// cancel — that endpoint keys on marvinSessionId, not turnId.
    /// Cleared when the user resets.
    private(set) var marvinSessionId: String? = nil

    /// ADR-0036 — the tier-1 live to-do list (a bare `TodoWrite` checklist with
    /// no plan behind it). Each TodoWrite rewrites the whole list, so we replace
    /// this wholesale; drives the tier-1 TodoListStrip. Cleared on a fresh SDK
    /// session. Tier-2 (plan-backed) work lives in `plans`, not here.
    var todos: [TodoItem] = []

    /// ADR-0046 — every plan presented this session, each owning its steps. A
    /// new plan APPENDS a navigable entry (revision-aware by slug) rather than
    /// clobbering the prior one; `activePlanId` selects the one shown in the
    /// strip. Cleared on a fresh SDK session.
    var plans: [Plan] = []
    var activePlanId: String? = nil

    /// The plan currently shown in the strip (tier 2). nil => tier 1 / no plan.
    var activePlan: Plan? { plans.first { $0.id == activePlanId } }

    /// Back-compat read shims for the call sites that predate ADR-0046's plan
    /// list. All WRITES go through `ingestPlan` / `applyTodoWrite` / the
    /// mutators below — never assign these directly.
    var currentPlanText: String? { activePlan?.text }
    var currentPlanPath: String? { activePlan?.path }
    var planTitle: String? { activePlan?.title }

    /// Title pulled from a plan's `# Plan — <title>` heading (the plan-mode
    /// prompt contract). The model often writes preamble BEFORE the heading, so
    /// we scan for the `# Plan` line anywhere — not just line 1 — and parse the
    /// title after the `Plan` word + its separator (— / - / :). Falls back to
    /// "Plan".
    static func planTitle(from text: String) -> String {
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            guard line.hasPrefix("#") else { continue }
            let afterHashes = line.drop(while: { $0 == "#" || $0 == " " })
            guard afterHashes.lowercased().hasPrefix("plan") else { continue }
            let afterPlan = afterHashes.dropFirst(4)
                .drop(while: { $0 == " " || $0 == "—" || $0 == "–" || $0 == "-" || $0 == ":" })
                .trimmingCharacters(in: .whitespaces)
            return afterPlan.isEmpty ? "Plan" : afterPlan
        }
        return "Plan"
    }

    /// True when the active plan's top-level steps are all complete (ADR-0046 —
    /// sub-tasks deliberately excluded, so a sub-task-only TodoWrite can't read
    /// as "Plan complete").
    var activePlanComplete: Bool { activePlan?.isComplete ?? false }

    /// ADR-0046 — the checklist currently driving the paused/continue chips:
    /// the active plan's TOP-LEVEL steps (as TodoItems) when a plan is active,
    /// else the tier-1 todos. Keeps the paused-plan affordances reading the
    /// plan spine rather than a stale flat list.
    var trackedItems: [TodoItem] {
        if let steps = activePlan?.steps {
            return steps.map { TodoItem(content: $0.content, status: $0.status, activeForm: $0.activeForm) }
        }
        return todos
    }

    /// Clear all plans (fresh SDK session / session switch).
    func clearPlans() {
        plans = []
        activePlanId = nil
    }

    /// Mutate the active plan in place (reassign for @Observable to see it).
    private func updateActivePlan(_ mutate: (inout Plan) -> Void) {
        guard let idx = plans.firstIndex(where: { $0.id == activePlanId }) else { return }
        var p = plans[idx]
        mutate(&p)
        plans[idx] = p
    }

    /// ADR-0046 — ingest a presented plan. Splits off any preamble, derives the
    /// title + slug, seeds steps. A new slug appends a navigable entry and
    /// becomes active; an existing slug is a REVISION — steps are rebuilt but
    /// prior step/sub-task progress is carried forward. Never clobbers a prior
    /// plan. Then persists + opens the file (Cursor-style).
    /// `announce` posts the plan as a `📋 Plan` system row — used on the
    /// ExitPlanMode path where the plan came from a tool input (no inline card).
    /// The turnCompleted path leaves it false: the plan is already the inline
    /// assistant reply (the plan card), so a system row would duplicate it.
    func ingestPlan(_ raw: String, announce: Bool = false, openFile: Bool = true) {
        let body = PlanCard.split(raw)?.plan ?? raw
        guard !body.isEmpty else { return }
        let title = Self.planTitle(from: body)
        let slug = PlanFile.slug(title)
        let seeded = PlanParser.steps(from: body)

        if let idx = plans.firstIndex(where: { $0.id == slug }) {
            // Revision: carry status/activeForm/subtasks for steps that survive.
            let old = plans[idx].steps
            let merged = seeded.map { step -> PlanStep in
                guard let prev = old.first(where: { $0.id == step.id }) else { return step }
                var s = step
                s.status = prev.status
                s.activeForm = prev.activeForm
                s.subtasks = prev.subtasks
                return s
            }
            var p = plans[idx]
            let changed = p.text != body
            p.text = body
            p.title = title
            p.steps = merged
            plans[idx] = p
            activePlanId = slug
            if announce && changed { messages.append(.system(text: "📋 Plan (revised)\n\n\(body)")) }
        } else {
            plans.append(Plan(id: slug, title: title, text: body, path: nil, steps: seeded))
            activePlanId = slug
            if announce { messages.append(.system(text: "📋 Plan\n\n\(body)")) }
        }
        persistAndOpenPlan(open: openFile)
    }

    /// ADR-0046 — apply a `TodoWrite` list. With a plan active, reconcile into
    /// its steps (match → update, unmatched → nested sub-task) so the plan is
    /// never erased; otherwise drive the tier-1 list wholesale (legacy).
    func applyTodoWrite(_ items: [TodoItem]) {
        if activePlanId != nil {
            updateActivePlan { $0.steps = PlanProgress.reconcile(steps: $0.steps, with: items) }
            // Mirror the updated progress + any discovered sub-tasks into the
            // saved plan file (ADR-0046 follow-up). open: false so a progress
            // tick never steals the editor focus.
            persistAndOpenPlan(open: false)
        } else {
            // Tier 1 — no plan. Items shouldn't carry `[N]` tags here, but strip
            // any the model emits so the bare task-list strip stays clean
            // (ADR-0049).
            todos = items.map {
                TodoItem(content: PlanTag.strip($0.content), status: $0.status, activeForm: $0.activeForm)
            }
        }
    }

    /// Switch the active plan (the strip's plan picker). Re-focuses its file.
    func selectPlan(_ id: String) {
        guard plans.contains(where: { $0.id == id }) else { return }
        activePlanId = id
        if let path = activePlan?.path { MarvinBridge.shared.setSelectedFile(path) }
    }

    /// Write the presented plan to `<workDir>/.marvin/plans/<slug>.md` and
    /// open it in the editor pane (Cursor opens the plan file in the preview).
    /// Idempotent per plan text — re-presenting the same plan re-uses the path.
    /// Best-effort: a write failure leaves `currentPlanPath` nil (the inline
    /// card + strip still work) rather than surfacing an error mid-plan.
    /// `open` focuses the plan file in the editor pane (the live-ingest
    /// behaviour). Rehydration on session switch passes `open: false` — it
    /// just needs the path set so "Open plan" works, without stealing the
    /// editor on every chat switch. The write is idempotent (skipped when the
    /// file already matches) so rehydrating doesn't churn the file / watcher.
    func persistAndOpenPlan(open: Bool = true) {
        guard let plan = activePlan, !plan.text.isEmpty,
              let wd = MarvinBridge.shared.projectWorkDir, !wd.isEmpty else { return }
        let dir = (wd as NSString).appendingPathComponent(".marvin/plans")
        let path = (dir as NSString).appendingPathComponent("\(plan.id).md")
        // The file is a live projection of the plan text + step progress
        // (checkboxes + nested sub-tasks), not the raw presented markdown.
        let rendered = PlanFile.render(plan)
        do {
            let onDisk = try? String(contentsOfFile: path, encoding: .utf8)
            if onDisk != rendered {
                try FileManager.default.createDirectory(
                    atPath: dir, withIntermediateDirectories: true)
                try rendered.write(toFile: path, atomically: true, encoding: .utf8)
            }
            updateActivePlan { $0.path = path }
            if open { MarvinBridge.shared.setSelectedFile(path) }
        } catch {
            // Non-fatal — the plan card + strip don't depend on the file.
        }
    }

    /// Re-focus the saved plan file in the editor pane (the strip's "Open
    /// plan" button). No-op if the plan was never written.
    func openPlanInEditor() {
        guard let path = activePlan?.path else { return }
        MarvinBridge.shared.setSelectedFile(path)
    }

    /// ADR-0036 (revised) — a Plan-mode turn just finished presenting a plan
    /// (read-only), so we're waiting on the user to Approve & execute. Drives
    /// the inline approval chip; cleared on the next send.
    var planAwaitingApproval: Bool = false

    /// Pull the `plan` string out of an ExitPlanMode confirm request.
    func planText(from request: ConfirmRequest) -> String? {
        guard case let .object(dict)? = request.input,
              case let .string(plan)? = dict["plan"] else { return nil }
        return plan.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Concatenated text of the most recent assistant message — the plan, when
    /// a Plan-mode turn just finished. Skips tool-call / non-text blocks.
    func lastAssistantText() -> String? {
        guard let msg = messages.last(where: { $0.role == .assistant }) else { return nil }
        let joined = Self.messageText(msg)
        return joined.isEmpty ? nil : joined
    }

    /// Concatenated text of a message's text blocks. Shared by
    /// `lastAssistantText` and the replay plan-reconstruction (ADR-0047).
    static func messageText(_ msg: ChatMessage) -> String {
        msg.blocks
            .compactMap { if case let .text(_, text) = $0 { return text } else { return nil } }
            .joined(separator: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// ADR-0034 — the agent's pending changed set (Cursor-style review).
    /// Refreshed live while edits stream (throttled) and on turn end;
    /// drives the AgentChangesStrip above the input bar.
    var agentChangedFiles: [AgentChangedFile] = []
    /// Throttle stamp for live refreshes — at most one fetch per 2 s
    /// while cli.events stream.
    private var lastChangesRefresh: Date = .distantPast

    /// Fetch the changed set for the active session. `force` skips the
    /// throttle (turn boundaries, post-review mutations).
    func refreshAgentChanges(force: Bool = false) {
        guard let sid = marvinSessionId ?? loadedSessionId,
              let cwd = MarvinBridge.shared.projectWorkDir, !cwd.isEmpty
        else { return }
        let now = Date()
        if !force, now.timeIntervalSince(lastChangesRefresh) < 2 { return }
        lastChangesRefresh = now
        Task { @MainActor in
            let files = (try? await ChangesService.shared.fetchChanges(
                cwd: cwd, marvinSessionId: sid)) ?? []
            self.agentChangedFiles = files
        }
    }

    /// Phase 2h — the (projectId, sessionId) pair that the current
    /// in-memory message list reflects. Set when hydrate succeeds;
    /// the view's bridge-change observer compares the bridge's
    /// reported pair against this to decide whether to re-hydrate.
    /// Without this, every redundant `session-changed` from the web
    /// would re-fetch the same transcript and zap any in-progress
    /// state.
    private(set) var loadedProjectId: String? = nil
    private(set) var loadedSessionId: String? = nil

    /// Phase 2h — the live-tail Task. Distinct from `activeTask`
    /// (which owns a POST-driven turn we initiated) because the
    /// resume tail can run in parallel with no local turn — we're
    /// just listening to whatever the sidecar's bus emits.
    private var resumeTask: Task<Void, Never>?

    /// ADR-0043 — the per-project announce subscription. Held open the whole
    /// time a project is loaded so an idle session catches a server-initiated
    /// turn (background-job completion / timed wakeup) it did NOT start. The
    /// existing `resumeTask`/`attachLive` only ran on hydrate, so those turns
    /// streamed into the bus with no listener and were invisible until a
    /// session switch. This closes that gap.
    private var announceTask: Task<Void, Never>?
    private var announceProjectId: String?

    /// ADR-0043 — true while the live tail is following a turn the client did
    /// NOT start (attached via the announce path). Lets its terminal clear the
    /// background-job affordance below.
    private var tailingServerTurn: Bool = false

    /// ADR-0043 — true while a background job MARVIN started is in flight, so
    /// the UI distinguishes "still running" from "done". Best-effort: set when
    /// a `run_background_job` tool_use lands in the stream, cleared when the
    /// next server-initiated turn completes.
    private(set) var backgroundJobRunning: Bool = false

    /// ADR-0044 — count of open+doing backlog items; drives the tray chip.
    /// Refreshed on session load + turn completion (cheap GET).
    private(set) var backlogOpenCount: Int = 0
    func refreshBacklogCount() {
        guard let wd = MarvinBridge.shared.projectWorkDir else {
            backlogOpenCount = 0
            return
        }
        Task { @MainActor in
            backlogOpenCount = await BacklogService.shared.openCount(workDir: wd)
        }
    }

    /// Phase 2h — true while we're fetching the transcript JSON.
    /// Surfaces a thin "loading" affordance so the user doesn't
    /// see an empty list and assume the project has no history.
    private(set) var isHydrating: Bool = false

    /// ADR-0048 — incremental history paging. Cold start paints the last
    /// `HISTORY_PAGE` lines; a top-of-list control loads the next page (and so
    /// on, up to the full log). `historyWindow` is how many lines are currently
    /// shown; `historyTotalTurns` the total on disk; `historyTruncated` true
    /// while more remain to load.
    static let historyPage = 200
    private(set) var isLoadingEarlierHistory: Bool = false
    private(set) var historyWindow: Int = 0
    private(set) var historyTotalTurns: Int? = nil
    private(set) var historyTruncated: Bool = false

    /// Past sessions for the active project — drives the header's
    /// Sessions menu. Sourced from GET /api/sessions and refreshed
    /// when the user opens the menu (so newly-completed turns from
    /// a parallel surface show up without a relaunch).
    private(set) var sessions: [SessionSummary] = []
    private var sessionsFetchTask: Task<Void, Never>?

    /// Cursor-style OPEN tabs — the ordered session IDs the user has
    /// opened in this window. Distinct from `sessions` (everything on
    /// disk): a chat joins this list when opened (new turn, or picked from
    /// the clock menu) and leaves it when its tab is closed. Persisted per
    /// project so tabs survive a relaunch.
    private(set) var openTabSessionIds: [String] = []

    /// Add a session to the open-tab strip (idempotent, appends right).
    func openTab(_ sessionId: String) {
        guard !openTabSessionIds.contains(sessionId) else { return }
        openTabSessionIds.append(sessionId)
        persistOpenTabs()
    }

    /// Close a tab. If it was the active one, fall back to a neighbour
    /// tab, or to a fresh chat when none remain.
    func closeTab(_ sessionId: String) {
        let wasActive = loadedSessionId == sessionId
        let idx = openTabSessionIds.firstIndex(of: sessionId)
        openTabSessionIds.removeAll { $0 == sessionId }
        persistOpenTabs()
        guard wasActive else { return }
        // Prefer the tab that was to the right (or the new last one).
        let next: String? = {
            guard let idx else { return openTabSessionIds.last }
            if idx < openTabSessionIds.count { return openTabSessionIds[idx] }
            return openTabSessionIds.last
        }()
        if let next {
            selectSession(next, fallbackProjectId: MarvinBridge.shared.activeProjectId)
        } else {
            clear()
        }
    }

    private func persistOpenTabs() {
        guard let pid = loadedProjectId else { return }
        UserDefaults.standard.set(openTabSessionIds, forKey: "marvin.openTabs.\(pid)")
    }

    /// Restore the persisted open-tab set for a project. Called when the
    /// active project resolves. Keeps only ids that still exist on disk.
    func loadOpenTabs(projectId: String) {
        let saved = UserDefaults.standard.stringArray(forKey: "marvin.openTabs.\(projectId)") ?? []
        openTabSessionIds = saved
    }

    /// Auto-hydrate: fetch sessions and load the right one. Called
    /// when no session is set (post-WebView-removal M5, activeMarvinSessionId
    /// is always nil, so this is the primary path for recovering history).
    /// Awaitable — callers don't need to sleep and poll.
    ///
    /// Prefers `NativePrefs.lastSessionId(forProject:)` so the user lands
    /// back on the conversation they actually had open, falling back to
    /// the most-recently-updated session when no preference is stored
    /// (fresh install) or the saved id no longer exists on disk.
    func autoHydrate(projectId: String) async {
        guard loadedSessionId == nil else { return }
        do {
            let res = try await ChatService.shared.fetchSessions(projectId: projectId)
            sessions = res.sessions
            guard loadedSessionId == nil else { return }
            let saved = NativePrefs.shared.lastSessionId(forProject: projectId)
            let target = saved.flatMap { id in sessions.first(where: { $0.sessionId == id }) }
                ?? sessions.first
            guard let target else { return }
            // Cold-start hydrate is bounded to the last 200 turns. A
            // session with 314 turns / 120 MB JSONL was freezing launch
            // for multiple seconds even before SwiftUI tried to render
            // it. Manual selectSession from the history menu still pulls
            // the full transcript — that's user-initiated and the wait
            // is expected.
            hydrate(projectId: projectId, sessionId: target.sessionId, tail: 200)
        } catch {
            NSLog("[ChatPreview] auto-hydrate failed: \(error)")
        }
    }

    /// Refresh the sessions list for `projectId`. Idempotent: a
    /// fetch in flight isn't re-started; subsequent calls await
    /// the existing task. Called on menu-open + after a turn
    /// completes (so a fresh turn shows up in history without a
    /// relaunch).
    func refreshSessions(projectId: String) {
        sessionsFetchTask?.cancel()
        sessionsFetchTask = Task { @MainActor in
            do {
                let res = try await ChatService.shared.fetchSessions(
                    projectId: projectId
                )
                guard !Task.isCancelled else { return }
                sessions = res.sessions
            } catch is CancellationError {
                /* quiet */
            } catch {
                NSLog("[ChatPreview] refreshSessions failed: \(error)")
            }
        }
    }

    /// Pick a past session — re-route hydrate to that sessionId.
    /// `fallbackProjectId` is passed by the view (from the bridge)
    /// so this works even before the first hydrate has set loadedProjectId.
    func selectSession(_ sessionId: String, fallbackProjectId: String? = nil) {
        guard let projectId = loadedProjectId ?? fallbackProjectId else { return }
        openTab(sessionId)  // opening a chat makes it a tab (Cursor-style)
        if loadedSessionId == sessionId { return }
        loadedSessionId = nil
        hydrate(projectId: projectId, sessionId: sessionId)
    }

    /// The last user-typed message, retained so the retry button
    /// can resubmit on stream errors without the user retyping.
    /// Cleared on successful completion (turn.completed) and on
    /// reset.
    private(set) var lastSentMessage: String? = nil

    /// The active stream's task, retained so we can cancel on
    /// teardown / second submit. Phase 2f wires the explicit
    /// /api/chat/cancel call alongside; the local task cancel
    /// alone only stops receiving events.
    private var activeTask: Task<Void, Never>?

    /// Send the current draft as a turn. No-op when already
    /// sending or both the draft AND attachments are empty.
    /// Phase 5e — attachments serialise into the message text
    /// (each chip becomes a `@/abs/path` token or a fenced
    /// snippet) so the agent loop sees them as part of the
    /// prompt, no /api/chat schema change required.
    func send(cwd: String?) {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachmentText = attachments
            .map { $0.messageFragment }
            .joined(separator: "\n")
        let composed: String
        if attachmentText.isEmpty {
            composed = trimmed
        } else if trimmed.isEmpty {
            composed = attachmentText
        } else {
            composed = "\(attachmentText)\n\n\(trimmed)"
        }
        guard !composed.isEmpty else { return }
        draft = ""
        attachments = []
        planAwaitingApproval = false  // any send clears the plan-approval chip
        // A finished plan must not shadow the next task. Once every plan step
        // is done, a fresh user-typed message starts new (tier-1) work, so
        // drop the finished unit — otherwise the next TodoWrite would render
        // under the old "Plan — <title>" header. Control actions (approve /
        // continue) use sendControl and bypass this, so mid-plan continues are
        // safe. ADR-0046 — a completed active plan is retired the same way
        // (only the finished one; other session plans stay navigable).
        if !todos.isEmpty, todos.allSatisfy({ $0.status == "completed" }) {
            todos = []
        }
        if activePlanComplete, let id = activePlanId {
            plans.removeAll { $0.id == id }
            activePlanId = plans.last?.id
        }
        if isSending {
            // Turn already running — queue for after it completes.
            // turn.completed pops the head of this list and dispatches
            // it via the same sendInternal path so the user can keep
            // typing without blocking on each response.
            queuedMessages.append(QueuedMessage(text: composed, cwd: cwd))
            return
        }
        sendInternal(message: composed, cwd: cwd)
    }

    /// Drop a queued message before it dispatches. Called by the
    /// queued-chip strip's per-row remove button.
    func removeQueued(_ id: UUID) {
        queuedMessages.removeAll { $0.id == id }
    }

    /// Phase 2f — re-submit the last user message after an error.
    /// No-op if there's no last message, or if a turn is already
    /// in flight (defensive — the retry button is hidden when
    /// isSending, but state can race).
    func retry(cwd: String?) {
        guard let lastSentMessage, !isSending else { return }
        sendInternal(message: lastSentMessage, cwd: cwd)
    }

    /// Send an instruction to the agent WITHOUT it appearing as a user-typed
    /// message (Cursor-style control action). The agent receives `instruction`
    /// (it needs it for context), but the chat shows the compact `display`
    /// control row instead of an un-editable fake user bubble. Used by
    /// Approve & execute / Continue. No-op while a turn is running.
    func sendControl(instruction: String, display: String, cwd: String?) {
        guard !isSending, !instruction.isEmpty else { return }
        planAwaitingApproval = false
        sendInternal(message: instruction, cwd: cwd, display: .system(text: display))
    }

    private func sendInternal(message: String, cwd: String?, display: ChatMessage? = nil) {
        isSending = true
        currentActivity = "Thinking…"
        lastError = nil
        lastSentMessage = message
        // Optimistic echo. The wire never sends a `user` event for what we
        // just submitted (SDK `user` cli.events carry tool_results, not user
        // inputs), so we add it ourselves before the assistant streams. A
        // `display` override (control actions) shows a system control row
        // instead of a user bubble.
        messages.append(display ?? .userText(message))

        // Phase 2g.1 — read permission strategy from UserDefaults
        // instead of hardcoding gated. The user picks via the
        // Settings panel (default: auto). Phase 2e hardcoded gated
        // so the confirm sheet path was exercisable while the
        // native chat lived in a side preview window; now that
        // Phase 2g.3 promotes it to the main chat surface, gated-
        // by-default would mean every tool call hit a confirm
        // prompt for users running in auto-mode — frustrating UX.
        let strategy = UserDefaults.standard.string(
            forKey: "marvin.permissionStrategy"
        ) ?? NativePermissionStrategy.auto.rawValue
        // ADR-0045 — read fresh from UserDefaults (like `strategy`) so the
        // Settings toggle is honored without NativePrefs in-memory staleness.
        let playwrightOn = UserDefaults.standard.bool(forKey: "marvin.playwrightEnabled")
        // Pull executor / advisor / personality from NativePrefs.
        // These are configured via the agents bar (the pills above
        // the messages) and must be sent in the request body — the
        // server otherwise falls through to `runtimeMode` and ends
        // up using opus regardless of what the user picked.
        let prefs = NativePrefs.shared
        // Phase 2h — pass the captured/hydrated marvinSessionId so
        // the server appends to the same session the web has been
        // writing to. Without this, every native send minted a fresh
        // session and the project ended up with two parallel JSONLs
        // (web-driven + native-driven) that never converged. Nil on
        // the very first turn for a brand-new project — server mints
        // one, we capture it via turn.started, future turns continue
        // the same id.
        // ADR-0022 §3 follow-up: consume the one-shot reset flag.
        // We capture-then-clear so a duplicate dispatch (e.g. from a
        // queued message draining after the reset turn started)
        // doesn't double-reset.
        let resetThisTurn = resetSdkOnNextSend
        if resetThisTurn { resetSdkOnNextSend = false }
        let request = ChatRequest(
            message: message,
            cwd: cwd,
            projectId: loadedProjectId,
            marvinSessionId: marvinSessionId,
            personality: prefs.personality,
            model: prefs.executorModel,
            advisorModel: prefs.advisorModel,
            permissionStrategy: strategy,
            playwrightEnabled: playwrightOn,
            mode: prefs.mode,
            thinkingMode: prefs.thinkingMode,
            advisorThinkingMode: prefs.advisorThinkingMode,
            resetSdkSession: resetThisTurn ? true : nil
        )
        activeTask = Task { @MainActor in
            defer {
                isSending = false
                currentActivity = nil
            }
            do {
                let stream = ChatService.shared.streamTurn(request: request)
                for try await event in stream {
                    handle(event: event)
                }
            } catch {
                lastError = "\(error)"
                // Transport-level failure (sidecar restart, network
                // drop, etc.) — no turn.error event will land. Mirror
                // the cleanup that case does so the UI doesn't sit
                // with a stale confirm sheet open or a streaming
                // pip on the latest assistant row.
                pendingConfirms.removeAll()
                for i in messages.indices where messages[i].isStreaming {
                    messages[i].isStreaming = false
                }
                MarvinBridge.shared.marvinState = "error"
                MarvinBridge.shared.isBusy = false
            }
        }
    }

    /// Phase 2f — explicit user cancel. Tears down the local SSE
    /// subscription AND POSTs /api/chat/cancel so the agent on the
    /// sidecar actually stops (not just our consumer). The /cancel
    /// is fire-and-forget — failure is logged but doesn't block
    /// the local teardown; a refreshed window can always re-issue.
    func cancel() {
        activeTask?.cancel()
        activeTask = nil
        isSending = false
        currentActivity = nil
        // Cancel is a hard reset — drop any pending queued messages
        // alongside the in-flight turn. Without this the user hits
        // Stop, sees the brain idle, then a stale queued message fires
        // half a second later and confuses them.
        queuedMessages.removeAll()
        // Seal any still-streaming rows so the chat doesn't sit there
        // showing "streaming…" forever on the row that was mid-write
        // when the user hit Stop.
        for i in messages.indices where messages[i].isStreaming {
            messages[i].isStreaming = false
        }
        // Drop any open confirm sheet — the SDK is being torn down
        // and its registry will be cleared, so Allow/Deny clicks
        // would 404. Auto-closing is the user-visible signal that
        // the cancel actually took effect.
        pendingConfirms.removeAll()
        // ADR-0021 M4: brief cancelling state → idle.
        MarvinBridge.shared.marvinState = "cancelling"
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            MarvinBridge.shared.marvinState = "idle"
            MarvinBridge.shared.isBusy = false
        }
        if let id = marvinSessionId {
            Task { @MainActor in
                do {
                    _ = try await ChatService.shared.cancelTurn(marvinSessionId: id)
                } catch {
                    NSLog("[ChatPreview] cancelTurn failed: \(error)")
                }
            }
        }
    }

    func clear() {
        cancel()
        resumeTask?.cancel()
        resumeTask = nil
        // ADR-0043 — drop the announce subscription; a fresh hydrate / first
        // turn re-arms it for whatever project loads next.
        announceTask?.cancel()
        announceTask = nil
        announceProjectId = nil
        tailingServerTurn = false
        backgroundJobRunning = false
        backlogOpenCount = 0  // ADR-0044
        messages.removeAll()
        pendingConfirms.removeAll()
        resolvedConfirms.removeAll()
        lastError = nil
        marvinSessionId = nil
        lastSentMessage = nil
        loadedProjectId = nil
        loadedSessionId = nil
        isHydrating = false
        resetSessionStrips()
    }

    /// Dismiss the plan checklist (the ✕ on the strip). ADR-0046 — drops only
    /// the ACTIVE plan, falling back to the next session plan if one remains, so
    /// dismissing one plan doesn't strand the others. With no plan active this
    /// clears the tier-1 task list instead.
    func dismissPlan() {
        if let id = activePlanId {
            plans.removeAll { $0.id == id }
            activePlanId = plans.last?.id
        } else {
            todos = []
        }
        planAwaitingApproval = false
    }

    /// Plan / to-do / changed-files state is SESSION-scoped — clear it when a
    /// session is left (new chat, switch). Otherwise the previous session's
    /// "Plan 7/7" + "N files changed" strips linger in a fresh chat.
    private func resetSessionStrips() {
        todos = []
        clearPlans()
        planAwaitingApproval = false
        agentChangedFiles = []
        // ADR-0048 — reset the history paging window for the new session.
        historyWindow = 0
        historyTotalTurns = nil
        historyTruncated = false
    }

    /// Phase 2h — fetch the transcript for `(projectId, sessionId)`,
    /// replay it through the same `ChatStreamReducer` the live SSE
    /// stream uses, then attach to any in-flight turn via
    /// /api/chat/resume so we don't miss events emitted between
    /// hydrate and attach.
    ///
    /// Idempotent: re-calling with a (projectId, sessionId) that
    /// matches `(loadedProjectId, loadedSessionId)` is a no-op. The
    /// caller (the bridge-change observer in ChatPreviewView) is
    /// expected to gate this anyway, but the inner guard makes the
    /// function safe to call from multiple sites without state
    /// double-loading.
    func hydrate(projectId: String, sessionId: String, tail: Int? = nil) {
        // Skip when nothing changed — protects in-progress drafts /
        // streams from a redundant session-changed echo.
        if loadedProjectId == projectId, loadedSessionId == sessionId {
            return
        }

        // Cancel any in-flight turn from the previous session so the
        // user doesn't see foreign events landing into the freshly
        // hydrated list.
        cancel()
        resumeTask?.cancel()
        resumeTask = nil

        loadedProjectId = projectId
        loadedSessionId = sessionId
        // ADR-0043 — keep the announce stream live for this project so an idle
        // session catches server-initiated turns it didn't start.
        ensureAnnounceLoop(projectId: projectId)
        refreshBacklogCount()  // ADR-0044 — light the tray chip if items are parked
        openTab(sessionId)  // hydrated session is an open tab (Cursor-style)
        isHydrating = true
        lastError = nil
        // Wipe state before replay — replay rebuilds the list from
        // scratch. We don't preserve `lastSentMessage` across
        // hydrate because retry semantics belong to the in-memory
        // turn, not the hydrated transcript.
        messages.removeAll()
        pendingConfirms.removeAll()
        resolvedConfirms.removeAll()
        marvinSessionId = sessionId
        lastSentMessage = nil
        // Plan / todo / changed-files strips are per-session — clear the
        // leaving session's before the new one's changed set refreshes below.
        resetSessionStrips()
        // Persist the choice so a relaunch returns here.
        NativePrefs.shared.setLastSessionId(sessionId, forProject: projectId)

        Task { @MainActor in
            defer { isHydrating = false }
            do {
                let record = try await ChatService.shared.fetchSession(
                    projectId: projectId,
                    sessionId: sessionId,
                    tail: tail
                )
                // Drop the result if the session changed under us
                // mid-fetch (user clicked another project). The
                // observer will re-fire hydrate for the new pair.
                guard loadedSessionId == sessionId else { return }
                if let record {
                    replay(record: record)
                    // ADR-0048 — record the paging window. The cold-start paint
                    // is tail-capped for speed; a top-of-list control loads the
                    // next page on demand (no auto full-load → no 120 MB hit).
                    historyWindow = record.turns.count
                    historyTotalTurns = record.totalTurns
                    historyTruncated = record.truncated ?? false
                }
                // Whether we hydrated or not, attempt to tail any
                // live turn. 204 → harmless no-op.
                attachLive(marvinSessionId: sessionId)
            } catch {
                lastError = "Hydrate failed: \(error)"
            }
        }
    }

    /// ADR-0048 — load a larger history window on demand (the top-of-list
    /// "show earlier" control). `turns` is the new tail size to fetch; `nil`
    /// loads the FULL log. Decodes off-main, replays into the lazy list.
    /// Guards: only swaps if we're still on this session and not mid-send (a
    /// streaming turn's events aren't on disk yet, so replacing would drop
    /// them). Best-effort: a failure leaves the current window in place.
    func loadMoreHistory(turns: Int?) {
        guard let projectId = loadedProjectId, let sessionId = loadedSessionId,
              !isLoadingEarlierHistory else { return }
        isLoadingEarlierHistory = true
        Task { @MainActor in
            defer { isLoadingEarlierHistory = false }
            let rec = try? await ChatService.shared.fetchSession(
                projectId: projectId, sessionId: sessionId, tail: turns)
            guard let rec, loadedSessionId == sessionId, !isSending else { return }
            replay(record: rec)
            historyWindow = rec.turns.count
            historyTotalTurns = rec.totalTurns
            historyTruncated = rec.truncated ?? false
        }
    }

    /// Load the next page of older lines (`HISTORY_PAGE` more).
    func loadNextHistoryPage() { loadMoreHistory(turns: historyWindow + Self.historyPage) }
    /// Jump straight to the complete log.
    func loadFullHistory() { loadMoreHistory(turns: nil) }

    /// Replay a stored SessionRecord into the message list using
    /// the same reducer the live stream uses. Phase 2h.
    private func replay(record: SessionRecord) {
        let encoder = JSONEncoder()
        var rebuilt: [ChatMessage] = []
        // ADR-0047 — the latest TodoWrite in the transcript carries the plan's
        // step statuses; captured here to restore progress after replay.
        var replayTodos: [TodoItem]? = nil

        for turn in record.turns {
            switch turn {
            case let .turnUser(_, message):
                // The optimistic-echo we mint locally on send isn't
                // in the wire, so the JSONL is the only place a
                // user-side row exists for replay. Reuse the same
                // factory `send` uses for visual parity.
                rebuilt.append(.userText(message))
            case let .cliEvent(_, event):
                // Re-encode the inner event to Data and feed the
                // reducer the same bytes a live cli.event would
                // carry — single source of truth for the rendering
                // pipeline.
                if let data = try? encoder.encode(event) {
                    rebuilt = ChatStreamReducer.apply(rebuilt, cliEventData: data)
                    if let todos = TodoExtractor.todos(from: data) { replayTodos = todos }
                }
            case let .turnError(_, err):
                // Match the live path's surface: a banner on the
                // most recent terminal failure. We don't replay a
                // separate row because the row UI for errors is
                // inline (and historical errors aren't actionable).
                lastError = err
            case .turnStarted, .turnCompleted, .confirmRequest,
                 .confirmDecision, .unknown:
                // turn.started — we already have marvinSessionId
                // set from the hydrate args; no row needed.
                // turn.completed — the cli.event `result` already
                // appended a "completed in Nms" row via the reducer.
                // confirm.* — historical confirms are settled by
                // the time we replay, no sheet to raise.
                // unknown — forward-compat skip.
                break
            }
        }

        // Tool calls whose tool_result never landed (interrupted
        // turn) end up with `result: nil`. The reducer keeps them in
        // place — the user sees the "running…" pip, which is wrong
        // for replayed history. Force-clear streaming flags on every
        // assistant message after replay; live streaming flags
        // re-enable themselves when the resume tail lands a fresh
        // assistant.
        for i in rebuilt.indices where rebuilt[i].isStreaming {
            rebuilt[i].isStreaming = false
        }

        messages = rebuilt

        // ADR-0047 — restore the session's PLAN + checklist from the transcript
        // so switching chats (or relaunching) doesn't lose it. The plan is the
        // last assistant `# Plan` reply (decoupled mode) or "📋 Plan" system
        // row (ExitPlanMode path); the last TodoWrite restores step progress.
        // openFile:false so rehydration doesn't yank the editor on every switch.
        if let planMsg = rebuilt.last(where: {
            ($0.role == .assistant || $0.role == .system) && PlanCard.isPlan(Self.messageText($0))
        }) {
            ingestPlan(Self.messageText(planMsg), announce: false, openFile: false)
        }
        if let replayTodos { applyTodoWrite(replayTodos) }
    }

    /// Phase 2h — attach to a live turn's event bus via
    /// /api/chat/resume. 204 collapses to a clean finish; otherwise
    /// events feed through the same `handle(event:)` path as a POST-
    /// driven turn so the merge logic in the reducer stays consistent.
    private func attachLive(marvinSessionId: String) {
        resumeTask?.cancel()
        resumeTask = Task { @MainActor in
            do {
                let stream = ChatService.shared.attachLive(
                    marvinSessionId: marvinSessionId
                )
                for try await event in stream {
                    // Drop late events for a session we've since
                    // navigated away from.
                    guard loadedSessionId == marvinSessionId else { break }
                    handle(event: event)
                }
            } catch {
                NSLog("[ChatPreview] attachLive failed: \(error)")
            }
        }
    }

    /// ADR-0043 — hold the per-project announce stream open (auto-reconnecting)
    /// while a project is loaded. Each `turn.registered` for a turn the client
    /// did NOT start (fired server-side while idle) triggers a re-attach via the
    /// existing `attachLive`, so a background-job completion / wakeup renders
    /// without a session switch. Idempotent per project.
    func ensureAnnounceLoop(projectId: String) {
        if announceProjectId == projectId, announceTask != nil { return }
        announceProjectId = projectId
        announceTask?.cancel()
        announceTask = Task { @MainActor in
            // The stream is long-lived but can drop (heartbeat reap, sidecar
            // restart). Re-attach with a short backoff until the project
            // changes or the task is cancelled.
            while !Task.isCancelled, announceProjectId == projectId {
                do {
                    let stream = ChatService.shared.announceStream(projectId: projectId)
                    for try await ann in stream {
                        guard announceProjectId == projectId else { break }
                        onAnnouncement(ann)
                    }
                } catch {
                    NSLog("[ChatPreview] announce stream error: \(error)")
                }
                if Task.isCancelled || announceProjectId != projectId { break }
                try? await Task.sleep(nanoseconds: 1_500_000_000)
            }
        }
    }

    /// React to a server-side turn registration. Only the session on screen is
    /// relevant, and only when we're idle: a turn we started ourselves is
    /// already streaming over our POST, and the sidecar DEFERS wakeup/job turns
    /// while a turn is live (`deferIfSessionBusy`), so an announcement that
    /// reaches us at idle is genuinely server-initiated.
    private func onAnnouncement(_ ann: TurnAnnouncement) {
        guard ann.marvinSessionId == loadedSessionId else { return }
        guard !isSending else { return }
        tailingServerTurn = true
        attachLive(marvinSessionId: ann.marvinSessionId)
    }

    /// True when an SSE `cli.event` carries a `run_background_job` tool_use —
    /// i.e. MARVIN just started a tracked background job (ADR-0038). Same wire
    /// shape `peekCLIEvent` reads.
    private func cliEventStartsBackgroundJob(_ data: Data) -> Bool {
        struct Wire: Decodable {
            let type: String
            struct Msg: Decodable {
                struct Block: Decodable {
                    let type: String
                    let name: String?
                }
                let content: [Block]?
            }
            let message: Msg?
        }
        guard let env = try? JSONDecoder().decode(Wire.self, from: data),
              env.type == "assistant",
              let blocks = env.message?.content
        else { return false }
        return blocks.contains {
            $0.type == "tool_use" && $0.name == "run_background_job"
        }
    }

    /// Respond to the head of the pending-confirms queue. Called
    /// from the ConfirmSheet view's button actions. Best-effort —
    /// network failure is logged + the confirm stays pending so the
    /// user can retry. The SDK timeout / explicit cancel will
    /// eventually unwind a stuck confirm.
    func respond(
        to request: ConfirmRequest,
        decision: ChatService.ConfirmDecision,
        denyMessage: String? = nil,
        updatedInput: [String: Any]? = nil
    ) {
        // Mark in-flight before the Task starts so the sheet's
        // dismiss-driven binding setter sees us and skips its
        // auto-deny safety net for this toolUseId. Without this guard
        // every Allow click double-POSTed (allow + deny) and the deny
        // usually won the race at /api/confirm.
        respondingToolUseIds.insert(request.toolUseId)
        Task { @MainActor in
            defer { respondingToolUseIds.remove(request.toolUseId) }
            do {
                try await ChatService.shared.respondToConfirm(
                    turnId: request.turnId,
                    toolUseId: request.toolUseId,
                    decision: decision,
                    denyMessage: denyMessage,
                    updatedInput: updatedInput
                )
                resolvedConfirms[request.toolUseId] = decision
                pendingConfirms.removeAll { $0.toolUseId == request.toolUseId }
            } catch ChatServiceError.httpStatus(404, _) {
                // Registry doesn't have this confirm anymore — the turn
                // ended (timeout, cancel, sidecar restart) between the
                // sheet opening and the user clicking. Drop the stale
                // sheet and surface a softer note so the user doesn't
                // see a HTTP stack trace; it's not a real error from
                // their POV, just expired UI state.
                pendingConfirms.removeAll { $0.toolUseId == request.toolUseId }
                lastError = "Confirm window expired — the turn already ended. Try again."
            } catch {
                lastError = "Confirm response failed: \(error)"
            }
        }
    }

    /// ADR-0021 M4 — peek at a cliEvent payload to derive both the
    /// brain-profile state ("tool" / "writing") AND a human-readable
    /// activity label for the input-bar progress line. Single decode
    /// pass over the assistant message's content blocks.
    ///
    /// Returns:
    ///   - state: "tool" if any tool_use block exists, "writing" if a
    ///     plain text block does, nil otherwise.
    ///   - activity: "Using <ToolName>" for tools (first match wins),
    ///     "Writing reply…" for text-only assistant messages.
    private struct CLIEventPeek {
        let state: String?
        let activity: String?
    }

    private func peekCLIEvent(_ data: Data) -> CLIEventPeek {
        struct Wire: Codable {
            let type: String
            struct Msg: Codable {
                struct Block: Codable {
                    let type: String
                    let name: String?
                }
                let content: [Block]?
            }
            let message: Msg?
        }
        guard let env = try? JSONDecoder().decode(Wire.self, from: data),
              env.type == "assistant",
              let blocks = env.message?.content
        else { return CLIEventPeek(state: nil, activity: nil) }
        if let toolBlock = blocks.first(where: { $0.type == "tool_use" }) {
            let label = toolBlock.name.map { "Using \($0)" } ?? "Using a tool"
            return CLIEventPeek(state: "tool", activity: label)
        }
        if blocks.contains(where: { $0.type == "text" }) {
            return CLIEventPeek(state: "writing", activity: "Writing reply…")
        }
        return CLIEventPeek(state: nil, activity: nil)
    }

    private func handle(event: ChatTurnEvent) {
        let b = MarvinBridge.shared
        switch event {
        case .turnStarted(let s):
            // Phase 2f — capture the marvinSessionId so cancel can
            // address /api/chat/cancel (which keys on it, not turnId).
            marvinSessionId = s.marvinSessionId
            // First turn on a new session has no loadedSessionId yet —
            // adopt the server-minted id so relaunch can autoHydrate
            // back into this conversation.
            if loadedSessionId == nil, let pid = loadedProjectId ?? b.activeProjectId {
                loadedSessionId = s.marvinSessionId
                if loadedProjectId == nil { loadedProjectId = pid }
                NativePrefs.shared.setLastSessionId(s.marvinSessionId, forProject: pid)
                // The just-started chat becomes an open tab (Cursor-style).
                openTab(s.marvinSessionId)
                // ADR-0043 — a brand-new chat has no hydrate; arm the announce
                // loop now so this session catches its own background-job turns.
                ensureAnnounceLoop(projectId: pid)
            }
            // ADR-0021 M4: drive brain profile natively from SSE.
            b.marvinState = "thinking"
            b.isBusy = true
            // ADR-0022 §3 follow-up: when the sidecar started this
            // turn with a fresh SDK session (either a brand-new
            // transcript or because we asked it to reset), clear the
            // resident-context counter so the AppStatusBar segment
            // visibly drops to "—" until the first assistant event
            // of the new turn lands. Without this the user would see
            // the old `ctx 147K` figure linger for the whole first
            // decision step, which makes the reset feel unconfirmed.
            if s.sdkSessionFresh == true {
                b.residentContextTokens = nil
                b.billableThisTurn = nil
                // 2026-05-27 graphify-drift audit — the "graph N · reads M"
                // chip is per SDK-session, same lifetime as the context
                // counter. Zero it on session-fresh so the next turn
                // starts from a clean slate the user can read.
                b.sessionGraphCalls = 0
                b.sessionFileReadCalls = 0
                b.sessionGraphSummaryCalls = 0
                // ADR-0036 — a fresh SDK session starts with no plan.
                todos = []
                clearPlans()
            }
        case .cliEvent(let data):
            // The reducer mutation must stay synchronous — the chat
            // list IS the rendered surface, so the SwiftUI commit
            // that follows is what the user actually sees on screen.
            messages = ChatStreamReducer.apply(messages, cliEventData: data)
            // ADR-0043 — MARVIN just started a tracked background job; light the
            // "running" affordance until its completion turn lands.
            if cliEventStartsBackgroundJob(data) {
                backgroundJobRunning = true
            }
            // ADR-0046 — apply the latest TodoWrite. With a plan active this
            // RECONCILES into the plan's steps (match → update, unmatched →
            // nested sub-task) so a partial list can't erase the plan; with no
            // plan it drives the tier-1 list wholesale. Synchronous like the
            // message reducer; the model write is cheap and drives the strip.
            if let latest = TodoExtractor.todos(from: data) {
                applyTodoWrite(latest)
            }
            // Bridge mutations get hopped to the next runloop tick.
            // Without this, fast cli.event streams stack synchronous
            // @Observable writes inside a SwiftUI layout commit and
            // tip macOS 26's tighter constraint-cycle detector,
            // crashing with EXC_BREAKPOINT on
            // -[NSWindow _postWindowNeedsUpdateConstraints].
            // Letting the writes land on the NEXT main-actor tick
            // means each mutation lands AFTER the in-flight layout
            // commits, so the constraint engine never re-enters
            // itself. See crash report MARVIN-2026-05-07-014721.ips.
            let peek = peekCLIEvent(data)
            Task { @MainActor in
                if let s = peek.state { b.marvinState = s }
                if let label = peek.activity { currentActivity = label }
                ContextUsageReader.applyTo(bridge: b, cliEventData: data)
                ToolUseCounter.applyTo(bridge: b, cliEventData: data)
                // ADR-0034 — keep the "N files changed" strip live while
                // the agent streams edits. Throttled inside (2 s), so
                // calling per-event is cheap.
                refreshAgentChanges()
            }
        case .confirmRequest(let c):
            // Phase 2e — queue the confirm; the view's sheet
            // modifier reacts to pendingConfirms.first and presents
            // a modal. We DON'T add a message row for it because
            // the toolCall block already shows "running…" status;
            // duplicating that into a system row would be noise.
            //
            // De-dup against existing pending entries (defensive —
            // the SDK shouldn't re-emit confirms for the same
            // toolUseId, but if it does we don't want a sheet
            // reappearing after the user already decided).
            if !pendingConfirms.contains(where: { $0.toolUseId == c.toolUseId }) {
                pendingConfirms.append(c)
            }
            // ADR-0036 — Plan mode: when the plan arrives (ExitPlanMode),
            // persist it in the chat AND seed the to-do checklist from its
            // steps, so the plan survives closing the approval window and is
            // tracked with checkmarks (Cursor-style) as MARVIN executes. The
            // model's own TodoWrite calls then refine the statuses.
            if c.toolName == "ExitPlanMode", let plan = planText(from: c),
               !plan.isEmpty {
                // ADR-0046 — ingest as a navigable plan entry (revision-aware,
                // never clobbers a prior plan), seeding its steps + file. The
                // plan came from a tool input (no inline card) → announce it.
                ingestPlan(plan, announce: true)
            }
        case .turnCompleted:
            // Post a notification entry for the bell log.
            let prompt = lastSentMessage.flatMap { s in
                s.count > 60 ? String(s.prefix(60)) + "…" : s
            } ?? "Turn completed"
            b.appendNotification(prompt)
            lastSentMessage = nil
            currentActivity = nil
            // The SDK's finally block auto-denies and clears any
            // unresolved confirms before turn.completed fires; if any
            // sheet is still open client-side it's now stale (clicking
            // Allow would 404 against an empty registry). Drop them so
            // the sheet auto-closes.
            pendingConfirms.removeAll()
            // ADR-0021 M4: reset brain to idle natively.
            b.marvinState = "idle"
            b.isBusy = false
            // ADR-0036 (revised) — a Plan-mode turn just finished presenting a
            // plan (read-only). Surface the inline Approve & execute affordance,
            // and capture the plan text (the turn's final assistant reply) so it
            // can be saved to a file + followed alongside the chat.
            // A plan turn just finished — offer approval, UNLESS the active
            // plan is already complete (it was executed; offering "approve &
            // execute" then would contradict "Plan complete N/N").
            planAwaitingApproval = (b.mode == "plan") && !activePlanComplete
            if planAwaitingApproval {
                // ADR-0046 — ingest the plan portion of the final reply as a
                // navigable entry (preamble before the `# Plan` heading stays in
                // the chat; the file + strip get the clean plan). ingestPlan
                // also persists + opens the file (Cursor-style).
                if let text = lastAssistantText() { ingestPlan(text) }
            }
            // ADR-0043 — a server-initiated turn (background-job completion /
            // wakeup) just finished rendering; settle the in-flight affordance
            // and the server-tail flag.
            if tailingServerTurn {
                tailingServerTurn = false
                backgroundJobRunning = false
            }
            // ADR-0021 M3: kick BranchService for dirty-count refresh.
            NotificationCenter.default.post(name: .marvinTurnCompleted, object: nil)
            // ADR-0034 — settle the changed-set strip at the turn boundary.
            refreshAgentChanges(force: true)
            // Refresh the session tab strip so a brand-new chat's first
            // turn surfaces as a tab without waiting for a relaunch.
            if let pid = loadedProjectId ?? b.activeProjectId {
                refreshSessions(projectId: pid)
            }
            // ADR-0044 — a turn may have parked a backlog item; refresh the chip.
            refreshBacklogCount()
            // Drain one queued message into the next turn. The activeTask
            // chain set isSending=false in its `defer` before this event
            // fires, so sendInternal() will start a fresh stream cleanly.
            // We dispatch on the next runloop tick to give the UI a frame
            // to render the just-completed turn before another starts.
            if let next = queuedMessages.first {
                queuedMessages.removeFirst()
                Task { @MainActor in
                    sendInternal(message: next.text, cwd: next.cwd)
                }
            }
        case .turnError(let e):
            lastError = e.error
            currentActivity = nil
            // ADR-0043 — a server-initiated turn errored; settle the affordance
            // so the chip doesn't linger as a phantom "running" forever.
            if tailingServerTurn {
                tailingServerTurn = false
                backgroundJobRunning = false
            }
            // Seal every still-streaming row — without this a turn
            // that errors before the SDK emits its final `result`
            // event leaves the latest assistant message stuck on a
            // "streaming…" pip with no way for the user to know it's
            // done.
            for i in messages.indices where messages[i].isStreaming {
                messages[i].isStreaming = false
            }
            // The SDK auto-denies all pending confirms in its finally
            // block before this event fires. Drop the local sheet
            // queue so an Allow/Deny click after the error doesn't
            // hit /api/confirm with an empty registry.
            pendingConfirms.removeAll()
            // ADR-0021 M4: signal error state natively.
            b.marvinState = "error"
            b.isBusy = false
            // Don't dispatch queued messages after an error — the user
            // may want to read the error and decide whether the queue
            // is still relevant. Cancel-from-bar drops the queue
            // explicitly when they want a clean reset.
        case .unknown:
            break
        }
    }
}

/// The preview window itself. Layout:
///
///   ┌──────────────────────────────────┐
///   │ Phase 2 preview · project        │
///   ├──────────────────────────────────┤
///   │ you   │ message text             │
///   │ marvin│ assistant text           │
///   │       │ ╭──────────────╮         │
///   │       │ │ Bash: npm test│        │
///   │       │ ╰──────────────╯         │
///   │ —     │ completed in 4123ms      │
///   ├──────────────────────────────────┤
///   │ ⚠ error banner (if any)          │
///   ├──────────────────────────────────┤
///   │ [text editor]              [Send]│
///   └──────────────────────────────────┘
struct ChatPreviewView: View {
    @Environment(MarvinBridge.self) private var bridge
    @Environment(\.openWindow) private var openWindow
    @State private var model = ChatPreviewModel()
    /// ADR-0044 — backlog browser sheet.
    @State private var backlogPanelOpen = false

    var body: some View {
        VStack(spacing: 0) {
            sessionTabs
            Divider()
            header
            Divider()
            // Agents bar — model pills, personality, perms (auto/gated).
            // Was previously below the input bar, sandwiched against
            // Send/Queue, which made the layout feel cramped: two rows
            // of small interactive pills competing for the eye next to
            // the primary submit button. Moving it above the messages
            // matches the convention in ChatGPT / Claude desktop and
            // keeps the input footer focused on Send / Queue / Stop.
            ChatAgentsFooter()
                .environment(bridge)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            Divider()
            // The message log OWNS the flexible vertical space — it expands
            // and contracts so the docked tray below never overlaps it.
            messagesPane
                .frame(minHeight: 140, maxHeight: .infinity)
            if let err = model.lastError {
                errorBanner(err)
            }
            // One clean, OPAQUE tray for every contextual strip, docked above
            // the input with a hard top border. Each strip is separated, so
            // session controls (Save to memory / Start fresh), the plan
            // checklist, and the changed-files review read as distinct rows
            // instead of bleeding into the log or into each other.
            statusTray
            ChatInputBar(
                text: Bindable(model).draft,
                onSubmit: { model.send(cwd: bridge.projectWorkDir) },
                onStop: { model.cancel() },
                isSending: model.isSending,
                activityLabel: model.currentActivity,
                queuedCount: model.queuedMessages.count,
                attachments: Bindable(model).attachments
            )
            .environment(bridge)
            .padding(.horizontal, 12)
            .padding(.top, 12)
            .padding(.bottom, 8)
        }
        .frame(minWidth: 280, minHeight: 200)
        .preferredColorScheme(bridge.preferredColorScheme)
        // Phase 2h — hydrate the message list when the bridge
        // reports a (projectId, marvinSessionId) we haven't loaded
        // yet. Three triggers funnel through the same code path:
        //   1. .onAppear catches the initial mount when the bridge
        //      already has a session id (web side raced ahead).
        //   2. .onChange of activeMarvinSessionId catches the most
        //      common case — web typed the first turn, captured the
        //      sid, announced it.
        //   3. .onChange of activeProjectId catches a project switch
        //      when the new project's session is the same id (rare
        //      but possible on a slug collision).
        // The model's hydrate method is itself idempotent against
        // the (loadedProjectId, loadedSessionId) it tracks — these
        // observers can fire redundantly without re-fetching.
        .onAppear {
            syncHydrateFromBridge()
            // ADR-0022 §3 follow-up: listen for the AppStatusBar
            // context segment's "Reset context for next message"
            // click. Arms the model's one-shot flag so the very next
            // send carries `resetSdkSession: true`. We post a small
            // chip-style hint so the user can see the intent took.
            NotificationCenter.default.addObserver(
                forName: .marvinRequestSdkReset,
                object: nil,
                queue: .main
            ) { _ in
                Task { @MainActor in
                    model.resetSdkOnNextSend = true
                }
            }
            // ADR-0034 — the Review Changes window lives in a separate
            // view tree; when it accepts/rejects a hunk it posts this so
            // our "N files changed" strip re-counts without waiting for
            // the next cli.event throttle window.
            NotificationCenter.default.addObserver(
                forName: .marvinAgentChangesDidMutate,
                object: nil,
                queue: .main
            ) { _ in
                Task { @MainActor in
                    model.refreshAgentChanges(force: true)
                }
            }
        }
        .onChange(of: bridge.activeMarvinSessionId) { _, _ in
            syncHydrateFromBridge()
        }
        .onChange(of: bridge.activeProjectId) { _, _ in
            syncHydrateFromBridge()
        }
        // Phase 2e — present the head of the confirm queue as a
        // modal sheet. We use isPresented bound to "is there a
        // pending confirm" (set: false denies the head) so the user
        // can dismiss with Esc and the model unwinds correctly. We
        // can't use .sheet(item:) here because that needs a
        // settable Binding<ConfirmRequest?> and the model exposes
        // an Array; the isPresented+head pattern reads more
        // explicitly than the binding gymnastics anyway.
        .sheet(isPresented: confirmSheetPresented) {
            if let request = model.pendingConfirms.first {
                // ADR-0040 — AskUserQuestion rides the confirm channel but is a
                // decision, not a permission: render the interactive question
                // sheet instead of Allow/Deny.
                if request.toolName == "AskUserQuestion" {
                    AskQuestionSheet(
                        request: request,
                        onSubmit: { answers in
                            model.respond(to: request, decision: .allow, updatedInput: answers)
                        },
                        onSkip: {
                            model.respond(
                                to: request,
                                decision: .deny,
                                denyMessage: "I'll let you decide — proceed with your own recommended option for each open question."
                            )
                        }
                    )
                } else {
                    ConfirmSheet(
                        request: request,
                        onAllow: {
                            model.respond(to: request, decision: .allow)
                        },
                        onDeny: { reason in
                            model.respond(to: request, decision: .deny, denyMessage: reason)
                        }
                    )
                }
            }
        }
        // ADR-0044 — the backlog browser.
        .sheet(isPresented: $backlogPanelOpen) {
            if let wd = bridge.projectWorkDir {
                BacklogPanel(
                    workDir: wd,
                    onPromote: { item in promoteBacklog(item, workDir: wd) },
                    onClose: { backlogPanelOpen = false },
                    onChanged: { model.refreshBacklogCount() }
                )
            }
        }
    }

    /// ADR-0044 — seed a turn from a backlog item and mark it in-progress.
    /// Promotion is always a user action — the backlog never self-executes.
    private func promoteBacklog(_ item: BacklogItem, workDir: String) {
        model.sendControl(
            instruction: "Implement this backlog item:\n\n**\(item.title)**\n\n\(item.body)",
            display: "⬆ Promoted from backlog: \(item.title)",
            cwd: workDir
        )
        Task {
            try? await BacklogService.shared.setStatus(workDir: workDir, id: item.id, status: "doing")
            model.refreshBacklogCount()
        }
    }

    /// Phase 2h — react to a (projectId, sessionId) bridge change.
    /// Three outcomes:
    ///
    ///   1. Both non-nil → hydrate. The model dedupes when the pair
    ///      already matches, so this is safe to fire redundantly.
    ///   2. sid nil, but model has a loaded session → web fired a
    ///      "new session" reset (⌘⇧N). Clear the native list to
    ///      match. Without this, a new-session in web leaves stale
    ///      history sitting on the native side.
    ///   3. Both nil from the start (no project active) → no-op;
    ///      the empty initial state is already correct.
    private func syncHydrateFromBridge() {
        if let pid = bridge.activeProjectId,
           let sid = bridge.activeMarvinSessionId {
            model.hydrate(projectId: pid, sessionId: sid)
            return
        }
        // sid went nil with state to clear → match the web reset.
        if model.loadedSessionId != nil || !model.messages.isEmpty {
            model.clear()
        }
        // Post-M5: activeMarvinSessionId is always nil (set only by the
        // now-removed WebView). Fetch sessions directly and pick the
        // latest — await the result instead of sleeping + polling.
        if let pid = bridge.activeProjectId,
           bridge.activeMarvinSessionId == nil,
           model.loadedSessionId == nil {
            Task { await model.autoHydrate(projectId: pid) }
        }
    }

    /// Two-way Binding into the head of pendingConfirms. `false`
    /// from the system (Esc / outside-click) denies the head with
    /// no message — matches the web's "card dismiss → deny"
    /// fallback. `true` is a no-op (we don't programmatically
    /// re-present; the next confirm queue head presents naturally
    /// via state observation).
    /// Sessions menu — shows past transcripts for the active
    /// project, lets the user pick one to load. Refreshes its list
    /// each time it opens so a turn that just completed in another
    /// surface (or just landed) shows up without a relaunch. Hidden
    /// when no project is active (the menu would have nothing useful).
    private var sessionsMenu: some View {
        Menu {
            if model.sessions.isEmpty {
                Button("(no past sessions)") {}
                    .disabled(true)
            } else {
                ForEach(model.sessions) { summary in
                    Button {
                        model.selectSession(
                            summary.sessionId,
                            fallbackProjectId: bridge.activeProjectId
                        )
                    } label: {
                        sessionLabel(for: summary)
                    }
                }
            }
            Divider()
            Button("Refresh") {
                if let pid = bridge.activeProjectId {
                    model.refreshSessions(projectId: pid)
                }
            }
        } label: {
            Image(systemName: "clock.arrow.circlepath")
        }
        .menuStyle(.borderlessButton)
        .controlSize(.small)
        .menuIndicator(.hidden)
        .frame(width: 28)
        .disabled(bridge.activeProjectId == nil)
        .help("Past sessions for this project")
        .onAppear {
            if let pid = bridge.activeProjectId {
                model.refreshSessions(projectId: pid)
            }
        }
        .onChange(of: bridge.activeProjectId) { _, pid in
            if let pid {
                model.refreshSessions(projectId: pid)
            }
        }
    }

    /// Cursor-style chat tab strip at the very top of the chat: recent
    /// sessions as one-click tabs (active highlighted) + a `+` for a new
    /// chat. Replaces the dropdown-only switching, which felt clunky. The
    /// clock menu in the header stays as the full-history overflow.
    private var sessionTabs: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    // A brand-new chat (nothing loaded yet) shows as its
                    // own active "New chat" tab until the first turn mints
                    // a session id that joins the open tabs.
                    if model.loadedSessionId == nil {
                        chatTab(title: "New chat", systemImage: "bubble.left.fill",
                                active: true, onSelect: {}, onClose: nil)
                    }
                    ForEach(model.openTabSessionIds, id: \.self) { sid in
                        chatTab(
                            title: tabTitle(forSessionId: sid),
                            systemImage: "bubble.left",
                            active: sid == model.loadedSessionId,
                            onSelect: {
                                model.selectSession(sid, fallbackProjectId: bridge.activeProjectId)
                            },
                            onClose: { model.closeTab(sid) }
                        )
                    }
                }
                .padding(.horizontal, 8)
            }
            Spacer(minLength: 4)
            Button {
                model.clear()
                if let pid = bridge.activeProjectId { model.refreshSessions(projectId: pid) }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .medium))
                    .frame(width: 24, height: 22)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .help("New chat (⌘⇧N)")
            .padding(.trailing, 8)
        }
        .frame(height: 32)
        .background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
        .onAppear {
            if let pid = bridge.activeProjectId {
                model.loadOpenTabs(projectId: pid)
                model.refreshSessions(projectId: pid)
            }
        }
        .onChange(of: bridge.activeProjectId) { _, pid in
            if let pid {
                model.loadOpenTabs(projectId: pid)
                model.refreshSessions(projectId: pid)
            }
        }
    }

    /// One open tab: a click-to-switch label + a close ✕. `onClose` nil
    /// hides the ✕ (the ephemeral "New chat" tab can't be closed).
    private func chatTab(
        title: String,
        systemImage: String,
        active: Bool,
        onSelect: @escaping () -> Void,
        onClose: (() -> Void)?
    ) -> some View {
        HStack(spacing: 4) {
            Button(action: onSelect) {
                HStack(spacing: 5) {
                    Image(systemName: systemImage)
                        .font(.system(size: 9))
                    Text(title)
                        .font(.system(size: 11))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .buttonStyle(.plain)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 14, height: 14)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Close tab")
            }
        }
        .padding(.leading, 9)
        .padding(.trailing, onClose == nil ? 9 : 5)
        .padding(.vertical, 4)
        .frame(maxWidth: 190, alignment: .leading)
        .foregroundStyle(active ? Color.primary : .secondary)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(active ? Color(nsColor: .textBackgroundColor) : Color.clear)
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(Color(nsColor: .separatorColor),
                                lineWidth: active ? 0.5 : 0)
                )
        )
        .help(title)
    }

    /// Short tab title for an open session id — its first user message,
    /// or its date, looked up from the loaded session list. Falls back to
    /// the id prefix when the summary isn't loaded yet.
    private func tabTitle(forSessionId sid: String) -> String {
        guard let s = model.sessions.first(where: { $0.sessionId == sid }) else {
            return String(sid.prefix(8))
        }
        if let msg = s.firstUserMessage?.replacingOccurrences(of: "\n", with: " "),
           !msg.trimmingCharacters(in: .whitespaces).isEmpty {
            return msg.count > 26 ? String(msg.prefix(24)) + "…" : msg
        }
        return friendlyDate(s.updatedAt)
    }

    /// Format a session-summary label: "M/D · 12 turns · first 60 chars".
    /// Concise enough to fit the menu width even with long first-user
    /// messages. We trim the user message at 60 chars (vs the wire's
    /// 120) because menu items get truncated anyway and the date +
    /// turn count carry most of the disambiguation value.
    private func sessionLabel(for s: SessionSummary) -> Text {
        let preview = (s.firstUserMessage ?? "(no preview)")
            .replacingOccurrences(of: "\n", with: " ")
        let trimmed = preview.count > 60
            ? String(preview.prefix(57)) + "…"
            : preview
        let date = friendlyDate(s.updatedAt)
        return Text("\(date) · \(s.turnCount)t · \(trimmed)")
    }

    /// "M/D" or "M/D HH:mm" for an ISO timestamp. Falls through to
    /// the raw string on parse failure (defensive — the route emits
    /// strict ISO 8601 today). Today's sessions get the time so users
    /// can disambiguate multiple same-day starts; older ones drop it.
    private func friendlyDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) else { return iso }
        let cal = Calendar.current
        let formatter = DateFormatter()
        formatter.dateFormat = cal.isDateInToday(date) ? "HH:mm" : "M/d"
        return formatter.string(from: date)
    }

    private var confirmSheetPresented: Binding<Bool> {
        Binding(
            get: { !model.pendingConfirms.isEmpty },
            set: { isPresenting in
                guard !isPresenting,
                      let head = model.pendingConfirms.first,
                      // Skip auto-deny if the user already clicked
                      // Allow/Deny — `dismiss()` fires the setter
                      // synchronously while the explicit response is
                      // still POSTing, and a second deny would race
                      // (and usually beat) the in-flight allow.
                      !model.respondingToolUseIds.contains(head.toolUseId)
                else { return }
                model.respond(to: head, decision: .deny)
            }
        )
    }

    /// ADR-0034 — open the Review Changes window. Stamps the target
    /// (cwd, session) pair the review model should fetch, then opens (or
    /// focuses) the dedicated "marvin-review" window. Using a real window
    /// — not a sheet clamped to this pane — gives the VS Code / Cursor
    /// diff-editor surface its room. The window's model posts
    /// `.marvinAgentChangesDidMutate` on every accept/reject; the observer
    /// in onAppear keeps this view's strip count honest across the window
    /// boundary.
    private func openReviewWindow() {
        guard let cwd = bridge.projectWorkDir,
              let sid = model.marvinSessionId ?? model.loadedSessionId else { return }
        ReviewWindowTarget.shared.cwd = cwd
        ReviewWindowTarget.shared.sid = sid
        openWindow(id: "marvin-review")
    }

    /// ADR-0036 — a Plan checklist exists, the turn is idle, and at least one
    /// item is unfinished: MARVIN has paused and is waiting on the user.
    private var planPausedWaiting: Bool {
        !model.isSending && model.trackedItems.contains { $0.status != "completed" }
    }

    /// The paused turn isn't just between steps — it's asking the user to
    /// DECIDE between options. The generic "Continue" chip is wrong here (it
    /// sends a canned resume and ignores the question); show the decision chip
    /// instead, which points the user at the input box + offers the model's
    /// own recommendation.
    private var planAwaitingDecision: Bool {
        planPausedWaiting && (model.lastAssistantText().map(PlanDecision.isAsking) ?? false)
    }

    /// One-click resume for a paused plan. The freeform input still works for
    /// a "continue + adjust" reply (what the user did manually). The chip is
    /// SPECIFIC — it names the next unfinished step and what there actually
    /// is to review (changed files / an error), instead of a bare "Review,
    /// then continue" that points at nothing.
    private var continuePlanChip: some View {
        let items = model.trackedItems
        let done = items.filter { $0.status == "completed" }.count
        let next = items.first { $0.status == "in_progress" }
            ?? items.first { $0.status == "pending" }
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.purple)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text("Paused — \(done)/\(items.count) steps done")
                    .font(.system(size: 11, weight: .semibold))
                if let next {
                    Text("Next: \(next.status == "in_progress" ? (next.activeForm ?? next.content) : next.content)")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let detail = pauseReviewDetail {
                    Text(detail)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer()
            Button {
                continuePlan()
            } label: {
                Label("Continue", systemImage: "arrow.right.circle.fill")
                    .font(.system(size: 11))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(model.isSending)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.purple.opacity(0.07))
    }

    /// What there is to review while paused, concretely. Error beats
    /// changed-files (it explains WHY the run stopped); nil when there's
    /// genuinely nothing to inspect — the chip then just offers Continue.
    private var pauseReviewDetail: String? {
        if model.lastError != nil {
            return "The turn stopped on an error (see above). Continue resumes from the last finished step."
        }
        let changed = model.agentChangedFiles.count
        if changed > 0 {
            return "\(changed) file\(changed == 1 ? "" : "s") changed so far — inspect via Review below, or just continue."
        }
        return nil
    }

    private func continuePlan() {
        // Cursor-style: a control action, not a fake user message.
        model.sendControl(
            instruction: "Continue with the remaining plan steps. First re-emit your "
                + "TodoWrite checklist with current statuses, then proceed and keep it "
                + "updated as you complete each item.",
            display: "▶ Continuing",
            cwd: bridge.projectWorkDir
        )
    }

    /// Shown when the paused turn is asking the user to choose between options.
    /// The primary path is to TYPE the answer in the box (works already); this
    /// chip makes that explicit and offers a one-click "use MARVIN's own
    /// recommendation" so the user isn't forced to retype the model's rec.
    private var decisionChip: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "questionmark.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text("MARVIN needs your decision")
                    .font(.system(size: 11, weight: .semibold))
                Text("Answer in the box below (e.g. \u{201C}1a, 2b\u{201D}), or let MARVIN proceed with its own recommendation.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button {
                proceedWithRecommendation()
            } label: {
                Label("Use MARVIN's rec", systemImage: "wand.and.stars")
                    .font(.system(size: 11))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(model.isSending)
            .help("Let MARVIN proceed using its own recommended option for each open decision.")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.orange.opacity(0.08))
    }

    private func proceedWithRecommendation() {
        // Control action — the model decides each open question with its own
        // stated recommendation, then resumes the checklist.
        model.sendControl(
            instruction: "For each open decision you just raised, proceed with your own "
                + "recommended option. If a decision had no clear recommendation, pick the "
                + "lowest-risk option and say which you chose. Re-emit your TodoWrite "
                + "checklist with current statuses, then continue and keep it updated.",
            display: "▶ Proceeding (MARVIN's recommendation)",
            cwd: bridge.projectWorkDir
        )
    }

    /// ADR-0036 (revised) — inline "Approve & execute" after a plan turn.
    private var approvePlanChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "checklist")
                .font(.system(size: 11))
                .foregroundStyle(.purple)
            Text("Plan ready — review above, then approve to execute (runs in Agent mode on the executor).")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
            // The plan is auto-written to .marvin/plans and opened in the
            // editor when it's presented; this button re-focuses that file.
            // If the auto-write failed (no path), fall back to a Save-As.
            Button {
                if model.currentPlanPath != nil { model.openPlanInEditor() }
                else { savePlan() }
            } label: {
                Label(model.currentPlanPath != nil ? "Open plan" : "Save plan",
                      systemImage: model.currentPlanPath != nil ? "doc.text" : "square.and.arrow.down")
                    .font(.system(size: 11))
            }
            .controlSize(.small)
            .disabled(model.currentPlanText?.isEmpty ?? true)
            .help(model.currentPlanPath != nil
                  ? "Open the saved plan file in the editor."
                  : "Save this plan to a Markdown file so you can follow it outside the chat.")
            Button("Revise") {
                // Stay in Plan mode; just nudge a revised plan.
                model.draft = "Revise the plan — "
            }
            .controlSize(.small)
            Button {
                approvePlan()
            } label: {
                Label("Approve & execute", systemImage: "play.fill")
                    .font(.system(size: 11))
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.purple.opacity(0.08))
    }

    /// Approve the presented plan: switch to Agent mode (so execution runs on
    /// the executor model, not the planning advisor) and start the run.
    /// Save the current plan to a Markdown file (Cursor-style — follow the
    /// plan in a file alongside the chat box). Defaults the panel to the
    /// project dir with a dated name; writes the plan text and opens it.
    private func savePlan() {
        guard let plan = model.currentPlanText, !plan.isEmpty else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.init(filenameExtension: "md") ?? .plainText]
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = "PLAN.md"
        if let wd = bridge.projectWorkDir {
            panel.directoryURL = URL(fileURLWithPath: wd)
        }
        panel.message = "Save the plan as Markdown — follow it alongside the chat."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            try plan.write(to: url, atomically: true, encoding: .utf8)
            NSWorkspace.shared.open(url)
        } catch {
            model.lastError = "Could not save the plan: \(error.localizedDescription)"
        }
    }

    private func approvePlan() {
        guard !model.isSending else { return }
        // ADR-0046 — the active plan already owns its steps (seeded at ingest);
        // execution reconciles the executor's TodoWrite into them. No tier-1
        // seeding here — that would double-render a task list under the plan.
        NativePrefs.shared.setMode("agent")
        // Cursor-style: approval is a control action. The agent gets the
        // execute instruction (hidden); the chat shows a compact control row.
        model.sendControl(
            instruction: "The plan you just presented is approved — execute it now. "
                + "Work through it in order, and maintain a TodoWrite checklist. ADR-0049 "
                + "TAGGING CONTRACT: prefix every TodoWrite item with its plan-step tag — "
                + "`[N]` for plan step N (1-based, in the order you presented them), and "
                + "`[N.M]` for the Mth sub-task of step N (work you break out or discover "
                + "under that step). Example: `[2] Wire the gate`, `[2.1] Add the agentID "
                + "check`, `[2.2] Cover it with a test`. A step auto-completes when all its "
                + "`[N.M]` sub-tasks are completed, so drive the sub-tasks and the parent "
                + "rolls up. Every TodoWrite you emit MUST still contain EVERY plan step "
                + "(each `[N]` carried forward with its status) plus all live sub-tasks — "
                + "never send a partial list that drops steps. If you hit a real decision, "
                + "call the AskUserQuestion tool with the options (don't write them as "
                + "prose) so I can pick one.",
            display: "▶ Plan approved — executing",
            cwd: bridge.projectWorkDir
        )
    }

    /// One opaque, clearly-separated tray for every contextual strip, docked
    /// above the input. A hard top border separates it from the scrolling
    /// message log (no more "the plan is in front of the log"), and each
    /// active strip is its own divider-separated row so session controls, the
    /// plan checklist, and the changed-files review never read as one blob.
    @ViewBuilder
    private var statusTray: some View {
        let rows = trayRows
        if !rows.isEmpty {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 { Divider() }
                    row
                }
            }
            .background(Color(nsColor: .windowBackgroundColor))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color(nsColor: .separatorColor))
                    .frame(height: 1)
            }
        }
    }

    /// The active strips, in priority order, as type-erased rows.
    private var trayRows: [AnyView] {
        var rows: [AnyView] = []
        if scopeMetVisible { rows.append(AnyView(scopeMetChipStrip)) }
        if model.backgroundJobRunning { rows.append(AnyView(backgroundJobChip)) }
        if model.backlogOpenCount > 0 { rows.append(AnyView(backlogChip)) }
        if model.resetSdkOnNextSend { rows.append(AnyView(resetArmedChip)) }
        if let plan = model.activePlan {
            // Tier 2 (ADR-0046) — the active plan: purple, titled, steps with
            // nested sub-tasks, a picker when several plans exist, and "Open
            // plan". Driven by the plan's steps, not a flat todo list.
            rows.append(AnyView(TodoListStrip(
                steps: plan.steps,
                planTitle: plan.title,
                plans: model.plans,
                activePlanId: model.activePlanId,
                onSelectPlan: { model.selectPlan($0) },
                onOpenPlanFile: { model.openPlanInEditor() },
                onClose: { model.dismissPlan() }
            )))
        } else if !model.todos.isEmpty {
            // Tier 1 — a bare TodoWrite checklist, no plan behind it.
            rows.append(AnyView(TodoListStrip(
                todos: model.todos,
                onClose: { model.dismissPlan() }
            )))
        }
        // Don't offer "Approve & execute" once the plan is already done —
        // a "Plan complete 10/10" strip + an approve chip is a contradiction.
        // (planPausedWaiting already excludes the all-complete case.)
        let planComplete = model.activePlanComplete
        if model.planAwaitingApproval && !model.isSending && !planComplete {
            rows.append(AnyView(approvePlanChip))
        } else if planAwaitingDecision {
            // Paused ON A QUESTION — show the decision chip (answer in box /
            // use the rec), not the generic "Continue".
            rows.append(AnyView(decisionChip))
        } else if planPausedWaiting {
            rows.append(AnyView(continuePlanChip))
        }
        if !model.agentChangedFiles.isEmpty {
            rows.append(AnyView(AgentChangesStrip(files: model.agentChangedFiles) { openReviewWindow() }))
        }
        if !model.queuedMessages.isEmpty { rows.append(AnyView(queuedStrip)) }
        return rows
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(bridge.projectName ?? "no project active")
                    .font(.callout.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let sid = model.loadedSessionId {
                    Text(sid.prefix(8))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            sessionsMenu
            // Stop moved to ChatInputBar so it sits next to Send / Queue
            // (where the eye is during a turn). ⌘. shortcut is wired
            // there too.
            //
            // Phase 2f — Clear (⌘⇧N) wipes the list, cancels any
            // in-flight turn, and resets the bridge state captured
            // from the last turn.started.
            Button("New") {
                model.clear()
            }
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .controlSize(.small)
            .disabled(model.messages.isEmpty && !model.isSending)
            .help("Reset preview state. ⌘⇧N")
        }
        .padding(12)
    }

    /// ADR-0048 — top-of-list history paging control: load the next page of
    /// older lines, or jump to the full log, with a live "N of M" count.
    private var historyPagingRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            if model.isLoadingEarlierHistory {
                ProgressView().controlSize(.small)
                Text("Loading earlier lines…")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            } else {
                Button("Show \(ChatPreviewModel.historyPage) earlier lines") {
                    model.loadNextHistoryPage()
                }
                .controlSize(.small)
                Button("Show full log") { model.loadFullHistory() }
                    .controlSize(.small)
                if let total = model.historyTotalTurns {
                    Text("\(model.historyWindow) of \(total) lines")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor).opacity(0.5))
    }

    private var messagesPane: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if model.messages.isEmpty {
                    emptyState
                } else {
                    // ADR-0048 — incremental history paging. When older lines
                    // remain, a top-of-list control loads the next page (or the
                    // full log). The list is bottom-anchored, so newly-loaded
                    // older lines appear above — scroll up to read them.
                    if model.historyTruncated || model.isLoadingEarlierHistory {
                        historyPagingRow
                    }
                    ForEach(model.messages) { msg in
                        ChatMessageRow(message: msg)
                            .padding(.horizontal, 12)
                            .id(msg.id)
                        Divider()
                            .opacity(0.4)
                    }
                }
            }
            .padding(.vertical, 8)
        }
        // Bottom-anchored scroll. macOS 14+ semantics:
        //   - First render lands at the bottom (latest message visible).
        //   - New content appended at the bottom keeps the bottom in
        //     view automatically — no manual scrollTo on count change.
        //   - User scrolling up detaches from the auto-stick; scrolling
        //     back to the bottom re-attaches.
        //   - Pane resize preserves relative position coherently.
        // The previous `.scrollPosition(id:)` approach caused chaotic
        // jumps with streaming-mutated row heights; this modifier
        // handles the dynamic-content case natively.
        .defaultScrollAnchor(.bottom)
        .background(Color(nsColor: .textBackgroundColor).opacity(0.4))
    }

    /// Pending-queue strip — renders one chip per message the user
    /// typed while a turn was in flight. Each chip shows a truncated
    /// preview and an X button to drop that entry before it dispatches.
    /// Sits between the messages pane and the input bar so it's visible
    /// while typing the next follow-up.
    /// ADR-0022 §3 — visible when the latest assistant message
    /// contains the `<!-- marvin:scope-met -->` sentinel. Only shows
    /// when the turn has actually completed (idle bridge state) so it
    /// doesn't flash mid-stream during a partial render.
    private var scopeMetVisible: Bool {
        guard !model.isSending else { return false }
        let text = latestAssistantText(in: model.messages)
        guard let text else { return false }
        return ScopeMetDetector.isPresent(in: text)
    }

    /// Concatenated text of the last assistant message in `messages`,
    /// or nil if there isn't one. Used by both the Scope-met
    /// detection check and the memory.md summary extractor so they
    /// agree on which text "the latest assistant" refers to.
    private func latestAssistantText(in messages: [ChatMessage]) -> String? {
        guard let latest = messages.last(where: { $0.role == .assistant }) else {
            return nil
        }
        let parts = latest.blocks.compactMap { block -> String? in
            if case let .text(_, t) = block { return t }
            return nil
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    /// Two-button affordance below the chat: save a one-line scope
    /// summary to memory.md, or clear the SDK session for the next
    /// logical task. Both are opt-in — neither auto-fires on Scope-met.
    private var scopeMetChipStrip: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Text("Scope met")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                if let cwd = bridge.projectWorkDir, !cwd.isEmpty {
                    let text = latestAssistantText(in: model.messages)
                    let summary = ScopeMetSummary.extract(from: text)
                    MemoryLog.append(workDir: cwd, line: summary)
                }
            } label: {
                Label("Save session note", systemImage: "tray.and.arrow.down")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Append a one-line summary of the just-completed scope to .marvin/session-notes.md. Durable facts (invariants/gotchas/constraints) are recorded by MARVIN via the remember tool into memory.md (ADR-0042).")
            Button {
                model.clear()
            } label: {
                Label("Start fresh next turn", systemImage: "arrow.uturn.left")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .keyboardShortcut("n", modifiers: [.command, .shift])
            .help("Clear the SDK session before the next message (⌘⇧N). memory.md auto-loads on the new session.")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            Color.secondary.opacity(0.05)
        )
    }

    /// ADR-0022 §3 follow-up — visible when the user has clicked
    /// "Reset context for next message" on the AppStatusBar context
    /// segment but hasn't sent the message yet. Communicates that the
    /// reset is armed and lets them un-arm it before sending. The
    /// chip clears automatically after the next send dispatches.
    /// ADR-0043 — visible while a background job MARVIN started is in flight,
    /// so "still running" is distinct from "done". Clears when the job's
    /// completion turn renders (pushed via the announce channel).
    private var backgroundJobChip: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .scaleEffect(0.7)
            Text("Background job running — I'll report here when it finishes")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.blue.opacity(0.08))
    }

    /// ADR-0044 — open backlog items parked for this project; opens the panel.
    private var backlogChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "tray.full")
                .font(.system(size: 10))
                .foregroundStyle(.blue)
            Text("\(model.backlogOpenCount) backlog item\(model.backlogOpenCount == 1 ? "" : "s") parked")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Spacer()
            Button("Open") { backlogPanelOpen = true }
                .font(.system(size: 11))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.blue.opacity(0.06))
    }

    private var resetArmedChip: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.counterclockwise")
                .font(.caption)
                .foregroundStyle(.orange)
            Text("Next message starts a fresh SDK session — chat stays, cache resets")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                model.resetSdkOnNextSend = false
            } label: {
                Text("Undo")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.orange.opacity(0.08))
    }

    private var queuedStrip: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(model.queuedMessages) { item in
                HStack(spacing: 6) {
                    Image(systemName: "hourglass")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Text(queuedPreview(item.text))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer()
                    Button {
                        model.removeQueued(item.id)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .buttonStyle(.plain)
                    .help("Remove from queue")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(Color.secondary.opacity(0.08))
                )
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
    }

    /// Single-line preview of a queued message, capped at ~80 chars
    /// so very long pastes don't blow out the strip width.
    private func queuedPreview(_ text: String) -> String {
        let collapsed = text.replacingOccurrences(of: "\n", with: " ")
        if collapsed.count > 80 {
            return String(collapsed.prefix(77)) + "…"
        }
        return collapsed
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("(no messages yet — type a message and ⌘⏎)")
                .font(.body.monospaced())
                .foregroundStyle(.tertiary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Stream error")
                    .font(.caption.weight(.semibold))
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Spacer()
            // Phase 2f — Retry resubmits the last user message
            // through the same path send() uses. Disabled when
            // there's nothing to retry (e.g. the error came from
            // an empty draft) and while a turn is somehow still
            // in flight (defensive — shouldn't happen because we
            // only set lastError after the catch).
            if model.lastSentMessage != nil {
                Button("Retry") {
                    model.retry(cwd: bridge.projectWorkDir)
                }
                .controlSize(.small)
                .disabled(model.isSending)
                .help("Resubmit the last message through /api/chat.")
            }
            Button("dismiss") { model.lastError = nil }
                .controlSize(.small)
                .buttonStyle(.borderless)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08))
    }
}
