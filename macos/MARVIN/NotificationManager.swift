// NotificationManager — macOS-native alerts for MARVIN events.
// Phase 1d.14; reworked for UX review N-01.
//
// It used to post one thing: "N confirms pending" on a 0 → N change of the
// confirm count, naming no tab and jumping to none. A tab that finished,
// failed or was cut off by a restart made no sound at all.
//
// Now it posts what `TabNotificationPlanner` (MARVINLogic) decides, one
// notification per kind of event, titled with the tab and carrying its id.
// Clicking one brings the app forward and selects that tab. A confirm or a
// question waiting on the user is one of those events, so the old count-based
// banner is gone, not duplicated.
//
// Permission is requested lazily — only when we actually have something to
// say — so a fresh user opening MARVIN for the first time doesn't get a
// permissions modal.
//
// Because clicks need a delegate, the delegate also decides presentation. Left
// to macOS' default, an app in front shows no banner at all; here the planner
// has already left out the one tab the user is looking at in the front app, so
// any other tab's event is shown even while MARVIN is in front.
//
// Disabling: macOS' System Settings → Notifications → MARVIN. There is no
// in-app switch, and none was added.

import AppKit
import Foundation
import MARVINLogic
import UserNotifications

@MainActor
final class NotificationManager {
    static let shared = NotificationManager()

    private var hasRequestedAuth = false
    private let delegate = Delegate()

    /// Whether this process can talk to the notification center at all. A bare
    /// SPM binary (the surface-snapshot harness) has no bundle, and
    /// UNUserNotificationCenter raises an uncatchable exception without one.
    private var available: Bool { Bundle.main.bundleIdentifier != nil }

    /// Take the delegate. Call at launch, so a click that launched the app is delivered.
    func install() {
        guard available else { return }
        UNUserNotificationCenter.current().delegate = delegate
    }

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

    func post(_ n: TabNotification) {
        guard available else { return }
        Task {
            await requestAuthorizationIfNeeded()
            let content = UNMutableNotificationContent()
            content.title = n.title
            content.body = n.body
            content.sound = .default
            content.threadIdentifier = "marvin.tabs"
            if let first = n.tabIds.first { content.userInfo = [Delegate.tabIdKey: first] }
            let request = UNNotificationRequest(identifier: n.identifier, content: content, trigger: nil)
            do {
                try await UNUserNotificationCenter.current().add(request)
            } catch {
                // Silent — see requestAuthorizationIfNeeded() comment.
            }
        }
    }

    /// A click: the app comes forward, the tab it was about is selected.
    fileprivate func open(tabId: String) {
        MainWindowFocus.bringForward()
        ChatPreviewModel.shared.selectSession(tabId, fallbackProjectId: MarvinBridge.shared.activeProjectId)
    }

    fileprivate final class Delegate: NSObject, UNUserNotificationCenterDelegate {
        static let tabIdKey = "marvinTabId"

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            willPresent notification: UNNotification
        ) async -> UNNotificationPresentationOptions {
            [.banner, .sound]
        }

        func userNotificationCenter(
            _ center: UNUserNotificationCenter,
            didReceive response: UNNotificationResponse
        ) async {
            guard let id = response.notification.request.content.userInfo[Self.tabIdKey] as? String else { return }
            await MainActor.run { NotificationManager.shared.open(tabId: id) }
        }
    }
}
