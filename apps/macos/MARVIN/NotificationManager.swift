// NotificationManager — macOS-native alerts for MARVIN events.
// Phase 1d.14.
//
// Currently watches the pending-confirm count parsed out of the
// bridge's webTitle (`(N) MARVIN`) and posts a system notification
// on 0 → N transitions. Resolving one of N doesn't re-notify; the
// dock-tile badge handles the still-pending count visually.
//
// Permission is requested lazily — only when we actually have a
// reason to send something — so a fresh user opening MARVIN-Swift
// for the first time doesn't immediately get a permissions modal.
//
// macOS by default suppresses banner notifications when the
// originating app is foregrounded, so the user doesn't see a
// banner for confirms they're already looking at. We rely on that
// default rather than implementing UNUserNotificationCenterDelegate.
//
// Disabling: macOS' System Settings → Notifications → MARVIN-Swift.

import AppKit
import Foundation
import UserNotifications

@MainActor
final class NotificationManager {
    static let shared = NotificationManager()

    /// Stable identifier — re-adding the request replaces the
    /// existing alert with the new content (so 1 → 2 → 3 transitions
    /// don't stack three banners). Re-using the identifier matches
    /// the dock-badge behavior of "current count, not history."
    private let confirmRequestID = "marvin.confirm-pending"

    private var hasRequestedAuth = false
    private var lastConfirmCount = 0

    /// Lazy authorization request. Idempotent — subsequent calls
    /// return immediately. The OS caches the user's answer.
    private func requestAuthorizationIfNeeded() async {
        guard !hasRequestedAuth else { return }
        hasRequestedAuth = true
        do {
            _ = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])
        } catch {
            // Silently fail — user denied or some signing issue
            // (ad-hoc-signed apps can hit edge cases here). The
            // dock-tile badge still shows the count, so this is
            // graceful degradation.
        }
    }

    /// Update the pending-confirm count. Posts a notification only
    /// on 0 → N transitions, so resolving one of three pending
    /// doesn't re-fire. The defer ensures `lastConfirmCount` is
    /// always updated regardless of whether we post.
    func updateConfirmCount(_ count: Int) {
        defer { lastConfirmCount = count }
        guard lastConfirmCount == 0, count > 0 else { return }
        Task { await postConfirmNotification(count: count) }
    }

    private func postConfirmNotification(count: Int) async {
        await requestAuthorizationIfNeeded()

        let content = UNMutableNotificationContent()
        content.title = "MARVIN"
        content.body = count == 1
            ? "1 confirm pending"
            : "\(count) confirms pending"
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: confirmRequestID,
            content: content,
            trigger: nil // immediate
        )
        do {
            try await UNUserNotificationCenter.current().add(request)
        } catch {
            // Silent — see requestAuthorizationIfNeeded() comment.
        }
    }
}
