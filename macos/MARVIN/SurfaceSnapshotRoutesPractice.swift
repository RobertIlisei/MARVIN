// SurfaceSnapshotRoutesPractice — Practice, Backlog, Models and the status-bar
// activity popover, for the stand-in sidecar (see SurfaceSnapshotRoutes.swift).
// Every name and number is invented. Practice dates carry fractional seconds
// because the pane's relative-time parser requires them.

import Foundation

extension SurfaceRoutesMore {
    // MARK: - Practice

    static let practice = #"""
    {
      "projectId": "tmp-demo-atlas",
      "config": {
        "enabled": true, "hour": 3, "thresholds": { "minSessions": 3, "minValue": 0.6 }, "verifyWindow": 5, "windowDays": 45,
        "weights": { "recurrence": 0.3, "cost": 0.2, "rate": 0.2, "reliability": 0.15, "actionability": 0.15, "decay": 0.1 },
        "fit": { "at": "2026-10-27T03:00:12.000Z", "samples": 14, "labelled": 9, "method": "rank-correlation", "rho": 0.62 }
      },
      "sessionsSeen": 38,
      "starters": [
        { "ruleId": "rule-thin-slice", "fingerprint": "plan.horizontal", "title": "Thin slice before widening the plan", "tier": "nudge",
          "message": "Re-present the plan with milestone 1 as a thin slice through every area.", "confirmedIn": ["alpha-service", "beta-web"] }
      ],
      "findings": [
        { "id": "ship.unreviewed", "kind": "ship.unreviewed", "polarity": "failure", "state": "proposed",
          "firstSeen": "2026-10-02T09:12:40.000Z", "lastSeen": "2026-10-29T16:41:05.000Z",
          "sessions": {
            "s-4a1f": { "count": 2, "cost": 2, "lastAt": "2026-10-29T16:41:05.000Z", "detail": "commit touching deploy/ci.yml with no review skill run this session" },
            "s-77be": { "count": 1, "cost": 1, "lastAt": "2026-10-21T11:03:00.000Z", "detail": "commit touching scripts/release.sh with no review skill run" } },
          "distinctSessions": 5, "costTotal": 7, "rate": 0.18, "value": 0.74, "unit": "commits", "template": true },
        { "id": "graph.first.skipped", "kind": "graph.first.skipped", "polarity": "failure", "state": "active",
          "firstSeen": "2026-10-03T10:00:00.000Z", "lastSeen": "2026-10-25T13:20:00.000Z",
          "sessions": { "s-91c2": { "count": 1, "cost": 9, "lastAt": "2026-10-25T13:20:00.000Z", "detail": "9 source files read before the first graph query" } },
          "distinctSessions": 6, "costTotal": 41, "rate": 0.22, "value": 0.81, "ruleId": "rule-graph-first",
          "sessionsAfter": 2, "recurrenceAfter": 0, "unit": "reads", "template": true },
        { "id": "turn.stalled", "kind": "turn.stalled", "polarity": "failure", "state": "regressed",
          "firstSeen": "2026-09-20T08:00:00.000Z", "lastSeen": "2026-10-28T17:45:00.000Z",
          "sessions": { "s-b007": { "count": 1, "cost": 620, "lastAt": "2026-10-28T17:45:00.000Z", "detail": "turn ended with no question or handoff; user typed continue" } },
          "distinctSessions": 7, "costTotal": 1840, "rate": 0.12, "value": 0.66, "ruleId": "rule-turn-stalled",
          "sessionsAfter": 4, "recurrenceAfter": 3, "unit": "seconds waited", "template": true },
        { "id": "plan.stale", "kind": "plan.stale", "polarity": "failure", "state": "fixed",
          "firstSeen": "2026-09-28T08:00:00.000Z", "lastSeen": "2026-10-18T12:00:00.000Z",
          "sessions": { "s-c110": { "count": 1, "cost": 4, "lastAt": "2026-10-18T12:00:00.000Z", "detail": "4 edits under a plan whose checklist was never updated" } },
          "distinctSessions": 4, "costTotal": 12, "rate": 0.09, "value": 0.62, "fixNote": "plan checklist now ticks itself on commit",
          "sessionsAfter": 3, "recurrenceAfter": 0, "unit": "turns", "template": true },
        { "id": "cache.recreated", "kind": "cache.recreated", "polarity": "failure", "state": "report",
          "firstSeen": "2026-10-10T08:00:00.000Z", "lastSeen": "2026-10-27T09:00:00.000Z",
          "sessions": { "s-d221": { "count": 1, "cost": 412000, "lastAt": "2026-10-27T09:00:00.000Z", "detail": "turn re-created a 412k-token prompt cache" } },
          "distinctSessions": 3, "costTotal": 412000, "value": 0.58, "unit": "tokens", "template": false },
        { "id": "scope.met.missing", "kind": "scope.met.missing", "polarity": "failure", "state": "confirmed",
          "firstSeen": "2026-09-05T08:00:00.000Z", "lastSeen": "2026-09-30T08:00:00.000Z",
          "sessions": { "s-e300": { "count": 1, "cost": 1, "lastAt": "2026-09-30T08:00:00.000Z", "detail": "turn edited files and ended without the scope-met handoff" } },
          "distinctSessions": 8, "costTotal": 11, "rate": 0.2, "value": 0.7, "ruleId": "rule-scope-met",
          "sessionsAfter": 9, "recurrenceAfter": 0, "unit": "turns", "template": true },
        { "id": "command.retried", "kind": "command.retried", "polarity": "failure", "state": "dismissed",
          "firstSeen": "2026-10-08T08:00:00.000Z", "lastSeen": "2026-10-22T08:00:00.000Z",
          "sessions": { "s-f400": { "count": 1, "cost": 3, "lastAt": "2026-10-22T08:00:00.000Z", "detail": "same failing command re-run unchanged 3 times" } },
          "distinctSessions": 3, "costTotal": 5, "rate": 0.05, "value": 0.61, "dismissReason": "flaky network in this sandbox, not a behaviour", "unit": "retries", "template": true },
        { "id": "skill.bypassed:review", "kind": "skill.bypassed", "polarity": "failure", "state": "observed",
          "firstSeen": "2026-10-20T08:00:00.000Z", "lastSeen": "2026-10-26T08:00:00.000Z",
          "sessions": { "s-g500": { "count": 1, "cost": 2, "lastAt": "2026-10-26T08:00:00.000Z", "detail": "review skill folder read by hand instead of invoking the skill" } },
          "distinctSessions": 2, "costTotal": 3, "rate": 0.04, "value": 0.41, "unit": "reads", "template": true },
        { "id": "ship.reviewed", "kind": "ship.reviewed", "polarity": "success", "state": "practice",
          "firstSeen": "2026-09-02T08:00:00.000Z", "lastSeen": "2026-10-29T16:50:00.000Z",
          "sessions": { "s-4a1f": { "count": 3, "cost": 3, "lastAt": "2026-10-29T16:50:00.000Z", "detail": "pr-review ran before a boundary commit" } },
          "distinctSessions": 19, "costTotal": 27, "value": 0.88, "unit": "commits", "template": false },
        { "id": "graph.first.followed", "kind": "graph.first.followed", "polarity": "success", "state": "practice",
          "firstSeen": "2026-09-02T08:00:00.000Z", "lastSeen": "2026-10-29T15:00:00.000Z",
          "sessions": { "s-91c2": { "count": 1, "cost": 1, "lastAt": "2026-10-29T15:00:00.000Z", "detail": "graph_search before the first Read" } },
          "distinctSessions": 31, "costTotal": 96, "value": 0.88, "unit": "turns", "template": false },
        { "id": "scope.met.present", "kind": "scope.met.present", "polarity": "success", "state": "practice",
          "firstSeen": "2026-09-02T08:00:00.000Z", "lastSeen": "2026-10-29T14:00:00.000Z",
          "sessions": { "s-b007": { "count": 1, "cost": 1, "lastAt": "2026-10-29T14:00:00.000Z", "detail": "turn ended with the scope-met handoff" } },
          "distinctSessions": 33, "costTotal": 140, "value": 0.88, "unit": "turns", "template": false }
      ],
      "rules": [
        { "id": "rule-graph-first", "builtin": false, "fingerprint": "graph.first.skipped", "title": "Graph before the first structural read", "tier": "nudge",
          "message": "Run a graph_* call before reading source files.", "status": "active", "scope": { "projectId": "tmp-demo-atlas" },
          "metrics": { "fired": 14, "lastFiredAt": "2026-10-29T16:02:11.000Z", "bypasses": 0 },
          "acceptedAt": "2026-10-24T09:30:00.000Z", "updatedAt": "2026-10-24T09:30:00.000Z" },
        { "id": "rule-turn-stalled", "fingerprint": "turn.stalled", "title": "End a turn with a question or a handoff", "tier": "prompt",
          "message": "Never end a turn silently: ask, or hand off.", "status": "active", "scope": { "projectId": null },
          "metrics": { "fired": 3, "lastFiredAt": "2026-10-28T17:44:00.000Z", "bypasses": 0 },
          "acceptedAt": "2026-10-12T09:30:00.000Z", "updatedAt": "2026-10-12T09:30:00.000Z" },
        { "id": "rule-scope-met", "fingerprint": "scope.met.missing", "title": "Close an editing turn with scope-met", "tier": "deny",
          "message": "Finish with the scope-met handoff line.", "status": "active", "scope": { "projectId": "tmp-demo-atlas" },
          "metrics": { "fired": 22, "lastFiredAt": "2026-10-29T14:00:00.000Z", "bypasses": 2 },
          "acceptedAt": "2026-09-08T09:30:00.000Z", "updatedAt": "2026-10-01T09:30:00.000Z", "suggestGlobal": true, "confirmedIn": 3 },
        { "id": "rule-retry-adapt", "fingerprint": "command.retried", "title": "Change something before re-running a failed command", "tier": "nudge",
          "message": "Do not re-run an identical failing command.", "status": "retired", "scope": { "projectId": "tmp-demo-atlas" },
          "metrics": { "fired": 1, "bypasses": 0 }, "acceptedAt": "2026-10-09T09:30:00.000Z", "updatedAt": "2026-10-22T09:30:00.000Z" },
        { "id": "builtin:graphify-first", "builtin": true, "fingerprint": "graph.first.skipped", "title": "Graph before the first structural read", "tier": "deny",
          "message": "The first Read / Grep / Glob of a turn is refused until a graph_* call has been made.", "status": "active", "scope": { "projectId": null },
          "metrics": { "fired": 57, "lastFiredAt": "2026-10-29T15:00:00.000Z", "bypasses": 3 }, "acceptedAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" },
        { "id": "builtin:graph-drift-deny", "builtin": true, "fingerprint": "graph.first.skipped", "title": "Graph drift stop", "tier": "deny",
          "message": "After 25 novel source files with no graph call, the next read is refused.", "status": "active", "scope": { "projectId": null },
          "metrics": { "fired": 4, "bypasses": 0 }, "acceptedAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" },
        { "id": "builtin:advisor-on-adr", "builtin": true, "fingerprint": "hook.deny.repeated:advisor-on-adr-trigger", "title": "Advisor before an ADR-trigger edit", "tier": "nudge",
          "message": "An edit on an auth, schema or CI path needs an advisor consult first.", "status": "active", "scope": { "projectId": null },
          "metrics": { "fired": 9, "bypasses": 1 }, "acceptedAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-10-05T00:00:00.000Z" },
        { "id": "builtin:ship-review", "builtin": true, "fingerprint": "ship.unreviewed", "title": "Review before a boundary commit", "tier": "deny",
          "message": "A commit touching a security boundary is refused until a review has run.", "status": "active", "scope": { "projectId": null },
          "metrics": { "fired": 12, "bypasses": 0 }, "acceptedAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" },
        { "id": "builtin:graph-pointer", "builtin": true, "fingerprint": "graph.pointer.wide", "title": "Narrow reads after the graph", "tier": "nudge",
          "message": "After a graph call, whole-file reads over 200 lines are flagged.", "status": "active", "scope": { "projectId": null },
          "metrics": { "fired": 31, "bypasses": 0 }, "acceptedAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z" },
        { "id": "builtin:plan-spine", "builtin": true, "fingerprint": "plan.spine.stale", "title": "Keep a seeded plan current", "tier": "prompt",
          "message": "Update the plan checklist between commits.", "status": "retired", "scope": { "projectId": null },
          "metrics": { "fired": 0, "bypasses": 0 }, "acceptedAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-10-11T00:00:00.000Z" }
      ],
      "runs": [
        { "at": "2026-10-30T03:00:09.000Z", "durationMs": 1840, "sessionsRead": 3, "sessionsSkippedLive": 1, "occurrences": 11, "findingsNew": 0, "recurring": 4, "proposed": 1, "confirmed": 0, "regressed": 1, "trigger": "nightly" },
        { "at": "2026-10-29T10:12:44.000Z", "durationMs": 9210, "sessionsRead": 38, "sessionsSkippedLive": 0, "occurrences": 142, "findingsNew": 6, "recurring": 9, "proposed": 3, "confirmed": 1, "regressed": 0, "trigger": "manual-backtest" },
        { "at": "2026-10-28T03:00:07.000Z", "durationMs": 1190, "sessionsRead": 2, "sessionsSkippedLive": 0, "occurrences": 5, "findingsNew": 1, "recurring": 3, "proposed": 0, "confirmed": 0, "regressed": 0, "trigger": "nightly" }
      ],
      "lastRun": { "at": "2026-10-30T03:00:09.000Z", "durationMs": 1840, "sessionsRead": 3, "sessionsSkippedLive": 1, "occurrences": 11, "findingsNew": 0, "recurring": 4, "proposed": 1, "confirmed": 0, "regressed": 1, "trigger": "nightly" }
    }
    """#

    // MARK: - Backlog

    static let backlog = #"""
    {
      "workDir": "@ROOT@",
      "items": [
        { "id": "document-retry-defaults", "title": "Document the retry policy defaults", "body": "The default attempt count and the delay cap are not written down anywhere a caller would look.", "status": "provisional", "severity": "low", "created": "2026-10-30T08:40:00.000Z", "kind": "docs" },
        { "id": "flaky-transport-timeout", "title": "Flaky timeout in the transport test", "body": "Fails about one run in twenty on a loaded machine. Unclear whether the fake transport or the timer is at fault.", "status": "provisional", "severity": "med", "created": "2026-10-30T08:41:00.000Z", "kind": "investigate" },
        { "id": "per-attempt-cost-ledger", "title": "Record the billed cost of each attempt, not only the request total", "body": "The ledger stores one figure per request, so a request that succeeded on its third attempt looks as cheap as one that succeeded on its first. The upstream exposes a per-attempt usage endpoint, but its response shape differs between the two API versions we talk to, and nothing yet says which version a given attempt went through. Probe both shapes against a recorded response before relying on either, record the attempt number beside the figure, and keep the request total as the sum so the existing reports do not change. Until then the dashboard's per-request cost is a floor, not the bill.", "status": "open", "severity": "high", "created": "2026-10-29T10:00:00.000Z", "kind": "feature" },
        { "id": "body-dropped-second-retry", "title": "Request body is dropped on the second retry", "body": "A streamed body is consumed by the first attempt, so the second attempt sends an empty request.", "status": "open", "severity": "high", "created": "2026-10-27T10:15:00.000Z", "kind": "bug" },
        { "id": "add-retry-jitter", "title": "Add jitter to the retry delay", "body": "A capped exponential delay synchronises clients that fail together. Add full jitter and pin the range in a test.", "status": "open", "severity": "med", "created": "2026-10-26T14:02:00.000Z", "kind": "feature" },
        { "id": "remove-legacy-shim", "title": "Remove the unused legacy transport shim", "body": "Nothing imports it since the client rewrite.", "status": "open", "severity": "low", "created": "2026-10-20T09:00:00.000Z" },
        { "id": "confirm-rate-limits", "title": "Confirm the upstream rate limits before tuning backoff", "body": "The cap we picked is a guess until the API owner answers.", "status": "open", "severity": "med", "created": "2026-10-24T16:30:00.000Z", "kind": "investigate", "blocked": true, "blockedOn": "waiting on the API owner to confirm the published limits" },
        { "id": "fix-body-replay", "title": "Replay a buffered body across attempts", "body": "Buffer small bodies, refuse to retry a stream that cannot be replayed.", "status": "doing", "severity": "high", "created": "2026-10-28T09:20:00.000Z", "kind": "bug", "claimedBy": "8cb24ed6-1f3a-4c11-9d0e-5a2b7c4e9f10", "claimedBranch": "marvin/tab/fix-body-replay" },
        { "id": "typed-error-classes", "title": "Introduce typed error classes for transport failures", "body": "Callers currently string-match error messages.", "status": "doing", "severity": "med", "created": "2026-10-25T11:11:00.000Z", "kind": "feature", "claimedBy": "d41a77e2-93b0-4e6c-8a55-0f1c2d3e4a5b" },
        { "id": "pin-backoff-range", "title": "Pin the backoff range in a unit test", "body": "Asserts the delay never exceeds the cap.", "status": "done", "severity": "med", "created": "2026-10-15T09:00:00.000Z", "kind": "test" },
        { "id": "rewrite-readme-intro", "title": "Rewrite the README introduction", "body": "Superseded by the docs restructure.", "status": "dismissed", "severity": "low", "created": "2026-10-10T09:00:00.000Z", "kind": "docs" }
      ]
    }
    """#

    // MARK: - Models, auth, activity

    static let models = #"""
    { "source": "live", "models": [
      { "id": "claude-opus-5", "displayName": "Claude Opus 5", "tier": "opus" },
      { "id": "claude-opus-4-8", "displayName": "Claude Opus 4.8", "tier": "opus" },
      { "id": "claude-sonnet-5", "displayName": "Claude Sonnet 5", "tier": "sonnet" },
      { "id": "claude-sonnet-4-6", "displayName": "Claude Sonnet 4.6", "tier": "sonnet" },
      { "id": "claude-haiku-4-5", "displayName": "Claude Haiku 4.5", "tier": "haiku" } ] }
    """#

    static let modelRoles = #"""
    { "roles": [
      { "role": "supervisor", "label": "Supervisor", "description": "Runs the project supervisor's wakes. Its spend counts against the supervisor's daily cap.", "default": { "kind": "tier", "tier": "sonnet" }, "anthropicOnly": false, "choice": null, "resolved": "claude-sonnet-5-5" },
      { "role": "scout", "label": "Scout", "description": "read-only research subagent", "default": { "kind": "inherit" }, "anthropicOnly": false, "choice": null, "resolved": "inherit" },
      { "role": "graphExtractor", "label": "Graph extractor", "description": "graphify semantic-pass subagent", "default": { "kind": "tier", "tier": "haiku" }, "anthropicOnly": false, "choice": null, "resolved": "claude-haiku-4-5" },
      { "role": "backgroundModel", "label": "Background", "description": "Claude Code's own small-model calls (the `haiku` alias)", "default": { "kind": "inherit" }, "anthropicOnly": false, "choice": "claude-haiku-4-5", "resolved": "claude-haiku-4-5" },
      { "role": "serverAdvisor", "label": "Server advisor", "description": "Claude's built-in advisor — sees the whole transcript; off by default", "default": { "kind": "off" }, "anthropicOnly": true, "choice": null, "resolved": null },
      { "role": "commitMessage", "label": "Commit messages", "description": "drafts a commit message from the staged diff", "default": { "kind": "tier", "tier": "haiku" }, "anthropicOnly": false, "choice": null, "resolved": "claude-haiku-4-5" },
      { "role": "practiceDraft", "label": "Practice drafts", "description": "drafts a practice rule's message from aggregates", "default": { "kind": "tier", "tier": "sonnet" }, "anthropicOnly": false, "choice": "claude-sonnet-4-6", "resolved": "claude-sonnet-4-6" },
      { "role": "sessionAuditor", "label": "Session auditor", "description": "read-only audit of a session, reported to you", "default": { "kind": "tier", "tier": "sonnet" }, "anthropicOnly": false, "choice": null, "resolved": "claude-sonnet-5" },
      { "role": "skillDiscoverer", "label": "Skill discovery", "description": "proposes project skills from the codebase", "default": { "kind": "tier", "tier": "sonnet" }, "anthropicOnly": false, "choice": null, "resolved": "claude-sonnet-5" } ] }
    """#

    static let authConfig = #"""
    { "config": { "mode": "cli", "provider": null, "keyHint": null, "savedAt": null },
      "effective": { "mode": "host-credentials", "credentialHint": "claude login", "error": null } }
    """#

    static let wakeups = #"""
    { "wakeups": [ { "id": "w1", "reason": "re-check the CI run for the retry branch", "fireAt": 1793350800000, "deferrals": 1 } ] }
    """#

    static let backgroundJobs = #"""
    { "jobs": [ { "id": "j1", "command": "npm test -- --watch", "reason": "watch client tests", "pid": 48211, "startedAt": "2026-10-30T09:00:00.000Z" } ] }
    """#

    static let autoAudit = #"""
    { "entries": [ { "at": "2026-10-30T09:12:44.000Z", "tool": "Edit", "descriptor": "src/client.ts" } ] }
    """#
}
