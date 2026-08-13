// CrashDiagnostics — capture the reason of an uncaught ObjC exception before
// AppKit kills the process.
//
// ## Why this exists
//
// MARVIN has died three times (2026-08-02, -08-05, -08-07) with an identical
// stack: an NSException thrown inside
// `-[NSWindow(NSDisplayCycle) _postWindowNeedsUpdateConstraints]`, reached from
// `NSHostingView.setNeedsUpdate()` during `NSHostingView.layout()`, ending at
// `+[NSApplication _crashOnException:]` (SIGTRAP).
//
// The `.ips` crash reports carry the BACKTRACE but not the exception's `name`
// or `reason` — the fields that would say what AppKit actually objected to.
// Nothing reaches the unified log or `~/Library/Logs/MARVIN/` either. Two fixes
// have now been attempted against a mechanism inferred from the stack alone,
// and the second one (freezing the slash-popup geometry measurement) did not
// stop it. Guessing a third time is not a strategy.
//
// So: capture the exception ourselves, persist it, and let the next occurrence
// name its own cause.
//
// ## How it hooks in
//
// Two independent paths, because the failing one is precisely the path that is
// hard to intercept:
//
//   1. `-[NSApplication reportException:]`, SWIZZLED. AppKit funnels exceptions
//      it catches in the main run loop and the display cycle through this
//      method, so it is the one that should fire for the crash above.
//   2. `NSSetUncaughtExceptionHandler` — the general path, for anything that
//      escapes without AppKit catching it first.
//
// ### Why swizzling, and not `NSPrincipalClass`
//
// The obvious approach is an `NSApplication` subclass overriding
// `reportException(_:)`, named in `Info.plist` ▸ `NSPrincipalClass`. That was
// tried first and is SILENTLY IGNORED: a SwiftUI `@main App` installs its own
// `AppKitApplication` before the plist key is consulted, so the subclass is
// never instantiated and the override never runs. It failed with no warning —
// the session stamp below exists precisely because that failure is invisible.
//
// Swizzling targets `object_getClass(NSApp)`, i.e. whatever class is actually
// live, so it works regardless of who created the app object. It uses only
// public Objective-C runtime API on a public method.
//
// Both paths write to `~/Library/Logs/MARVIN/exceptions.log` and then let the
// normal termination proceed. Nothing is swallowed: this changes what we KNOW
// about a crash, not whether it happens.

import AppKit
import Foundation

extension NSApplication {
    /// Swizzled counterpart of `reportException:`. After the implementations
    /// are exchanged this selector points at AppKit's ORIGINAL method, so the
    /// call at the end is the real `reportException:`, not recursion.
    @objc func marvin_reportException(_ exception: NSException) {
        ExceptionLog.record(exception, source: "NSApplication.reportException")
        marvin_reportException(exception)
    }
}

enum ExceptionLog {
    /// Append-only log next to the sidecar's, so a crash report and its cause
    /// are found in the same place.
    private static var logURL: URL {
        let dir = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/MARVIN", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("exceptions.log")
    }

    /// Install both hooks. Call once, as early as possible — an exception
    /// thrown before this runs is invisible.
    ///
    /// Stamps a session line recording which `NSApplication` class is live and
    /// whether the swizzle took. That is not decoration: the first attempt at
    /// this (an `NSPrincipalClass` subclass) failed SILENTLY, and without a
    /// positive statement in the log the only way to discover it would have
    /// been to wait for the next crash and find nothing captured.
    static func installHooks() {
        NSSetUncaughtExceptionHandler { exception in
            ExceptionLog.record(exception, source: "NSUncaughtExceptionHandler")
        }
        suppressCrashOnException()
        let armed = swizzleReportException()
        let appClass = String(describing: type(of: NSApplication.shared))
        let crashOnException = UserDefaults.standard.bool(forKey: "NSApplicationCrashOnExceptions")
        append(
            "\n----- \(ISO8601DateFormatter().string(from: Date())) — session start -----\n"
                + "NSApp class: \(appClass)\n"
                + "reportException hook: \(armed ? "ARMED (swizzled)" : "NOT ARMED — only NSSetUncaughtExceptionHandler is live")\n"
                + "NSApplicationCrashOnExceptions: \(crashOnException) "
                + "(\(crashOnException ? "exceptions KILL the app" : "exceptions are logged and survived"))\n"
        )
    }

    /// Ask AppKit to LOG rather than kill the process on an exception that
    /// escapes the main run loop / display cycle.
    ///
    /// Narrowly justified by what the 2026-08-07 capture finally showed:
    ///
    ///   NSGenericException — "The window has been marked as needing another
    ///   Update Constraints in Window pass, but it has already had more Update
    ///   Constraints in Window passes than there are views in the window."
    ///
    /// That is AppKit's own LOOP BREAKER. It is not a corruption signal and not
    /// a broken invariant in our data — it is a layout pass that failed to
    /// converge, and the cost of continuing is a stale frame, not undefined
    /// behaviour. The loop closes inside SwiftUI (`NSHostingView
    /// ._willUpdateConstraintsForSubtree` → `cancelAsyncRendering` →
    /// `setNeedsUpdate`), so there is nothing in MARVIN's own code to correct;
    /// dying over it costs the user a whole session for a frame of bad layout.
    ///
    /// `register` writes the REGISTRATION domain — the lowest-priority one — so
    /// this is a default, not an override: `defaults write net.marvin.macos
    /// NSApplicationCrashOnExceptions -bool YES` restores crashing.
    ///
    /// This is a MITIGATION, not a fix. The exception is still recorded on every
    /// occurrence, so the underlying non-convergence stays visible: an entry in
    /// `exceptions.log` with NO matching `.ips` afterwards means this worked.
    private static func suppressCrashOnException() {
        UserDefaults.standard.register(defaults: ["NSApplicationCrashOnExceptions": false])
    }

    /// Exchange `-[NSApplication reportException:]` with our logging version on
    /// whatever class `NSApp` actually is. Returns false if the method can't be
    /// found, in which case we simply keep the uncaught handler.
    @discardableResult
    private static func swizzleReportException() -> Bool {
        // The DYNAMIC class, not `NSApplication.self` — SwiftUI's app object is
        // an `AppKitApplication`. If that class doesn't override the method,
        // the runtime hands back NSApplication's and the exchange still works.
        guard let liveClass = object_getClass(NSApplication.shared),
              let original = class_getInstanceMethod(
                  liveClass, NSSelectorFromString("reportException:")
              ),
              let replacement = class_getInstanceMethod(
                  NSApplication.self, #selector(NSApplication.marvin_reportException(_:))
              )
        else { return false }
        method_exchangeImplementations(original, replacement)
        return true
    }

    /// Write one exception record. Deliberately synchronous and allocation-light
    /// — this runs while the process is on its way down, so anything deferred
    /// (a queue hop, an async write) would never land.
    static func record(_ exception: NSException, source: String) {
        let stack = exception.callStackSymbols.joined(separator: "\n    ")
        let stamp = ISO8601DateFormatter().string(from: Date())
        var entry = """

        ===== \(stamp) — uncaught exception via \(source) =====
        name:   \(exception.name.rawValue)
        reason: \(exception.reason ?? "(none)")
        """
        if let info = exception.userInfo, !info.isEmpty {
            entry += "\nuserInfo: \(info)"
        }
        entry += "\ncallStack:\n    \(stack)\n"
        append(entry)
    }

    /// Append one record. Deliberately synchronous — a crash record written on
    /// a queue would never land.
    private static func append(_ entry: String) {
        // Mirror to stderr too: when MARVIN is launched from a terminal the
        // reason shows up immediately, without going hunting for the file.
        FileHandle.standardError.write(Data(entry.utf8))

        guard let data = entry.data(using: .utf8) else { return }
        let url = logURL
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }
}
