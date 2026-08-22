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

    /// Swizzled counterpart of `+[NSApplication _crashOnException:]`.
    ///
    /// This is the method that ACTUALLY fires for the layout-loop crash, and
    /// the instance-method `reportException:` hook never sees it. Evidence
    /// (2026-08-18): 24 session starts, **zero** exceptions captured by that
    /// hook, while two crashes died in `_NSViewLayout → +[NSApplication
    /// _crashOnException:]` and wrote nothing at all. The one capture this log
    /// has ever held came from `NSSetUncaughtExceptionHandler` on 2026-08-07 —
    /// AppKit now catches the throw itself and traps before that handler runs.
    ///
    /// We log and then call through: the process is going down either way, and
    /// pretending otherwise is what made the previous stamp misleading. The
    /// point is that the NEXT crash names the offending view instead of leaving
    /// another inferred-from-the-stack guess (ADR-0062 burned two of those).
    @objc class func marvin_crashOnException(_ exception: NSException) {
        ExceptionLog.record(exception, source: "NSApplication._crashOnException (fatal)")
        ExceptionLog.recordWindowTree()
        marvin_crashOnException(exception)
    }

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
        let fatalArmed = swizzleCrashOnException()
        let stormArmed = swizzleSetNeedsUpdateConstraints()
        let splitArmed: Bool = {
            guard let a = class_getInstanceMethod(NSSplitViewController.self, #selector(NSViewController.loadView)),
                  let b = class_getInstanceMethod(NSSplitViewController.self, #selector(NSSplitViewController.marvin_loadView))
            else { return false }
            method_exchangeImplementations(a, b)
            return true
        }()
        let appClass = String(describing: type(of: NSApplication.shared))
        let crashOnException = UserDefaults.standard.bool(forKey: "NSApplicationCrashOnExceptions")
        // Stated precisely, because the previous wording ("exceptions are logged
        // and survived") was demonstrably false for the crash class it mattered
        // most for: 24 session starts, 0 captures, two fatal layout crashes.
        let survivalNote = crashOnException
            ? "exceptions KILL the app"
            : "non-layout exceptions are logged and survived; AppKit layout-cycle "
                + "exceptions are still FATAL — see the _crashOnException hook above"
        append(
            "\n----- \(ISO8601DateFormatter().string(from: Date())) — session start -----\n"
                + "NSApp class: \(appClass)\n"
                + "reportException hook: \(armed ? "ARMED (swizzled)" : "NOT ARMED — only NSSetUncaughtExceptionHandler is live")\n"
                + "_crashOnException hook: \(fatalArmed ? "ARMED (swizzled) — fatal layout exceptions are LOGGED WITH THE VIEW TREE, then still fatal" : "NOT ARMED — a layout-loop crash will die silently")\n"
                + "constraint-storm monitor: \(stormArmed ? "ARMED (\(ConstraintStorm.threshold) invalidations / \(ConstraintStorm.windowSeconds)s)" : "NOT ARMED")\n"
                + "split-view rebuild counter: \(splitArmed ? "ARMED" : "NOT ARMED")\n"
                + "NSApplicationCrashOnExceptions: \(crashOnException) "
                + "(\(survivalNote))\n"
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


    /// Exchange `+[NSApplication _crashOnException:]` — the CLASS method AppKit
    /// calls from the layout error path. Separate from the instance-method
    /// swizzle because they are different methods on different metaclasses;
    /// hooking one never hooks the other.
    @discardableResult
    private static func swizzleCrashOnException() -> Bool {
        guard let liveClass = object_getClass(NSApplication.shared),
              let meta = object_getClass(liveClass),
              let original = class_getClassMethod(
                  liveClass, NSSelectorFromString("_crashOnException:")
              ),
              let replacement = class_getClassMethod(
                  NSApplication.self, #selector(NSApplication.marvin_crashOnException(_:))
              )
        else { return false }
        _ = meta
        method_exchangeImplementations(original, replacement)
        return true
    }


    /// Dump the window/view tree alongside a fatal layout exception.
    ///
    /// The whole reason this crash is still open after 11 days is that the
    /// exception says a window "has had more Update Constraints passes than
    /// there are views" without naming WHICH view keeps invalidating. Two fixes
    /// were previously inferred from the stack alone and both were disproved.
    /// Recording the tree turns the next occurrence into evidence.
    static func recordWindowTree() {
        var out = "\n----- window/view tree at crash -----\n"
        for w in NSApplication.shared.windows {
            out += "window \(type(of: w)) frame=\(w.frame) visible=\(w.isVisible)\n"
            if let root = w.contentView { out += describe(root, depth: 1, limit: 400) }
        }
        append(out)
    }

    /// Depth-first view description, capped so a runaway tree cannot itself
    /// wedge the crash path.
    private static func describe(_ view: NSView, depth: Int, limit: Int) -> String {
        var emitted = 0
        func walk(_ v: NSView, _ d: Int) -> String {
            if emitted >= limit { return "" }
            emitted += 1
            let pad = String(repeating: "  ", count: d)
            var line = "\(pad)\(type(of: v)) frame=\(v.frame) constraints=\(v.constraints.count) needsUpdate=\(v.needsUpdateConstraints)\n"
            for sub in v.subviews { line += walk(sub, d + 1) }
            return line
        }
        return walk(view, depth)
    }

    /// Exchange `-[NSView setNeedsUpdateConstraints:]` so the storm monitor
    /// sees every invalidation. NSView, not a subclass — the invalidations come
    /// from AppKit and SwiftUI internals, so the hook has to sit on the base.
    @discardableResult
    private static func swizzleSetNeedsUpdateConstraints() -> Bool {
        guard let original = class_getInstanceMethod(
                  NSView.self, #selector(setter: NSView.needsUpdateConstraints)
              ),
              let replacement = class_getInstanceMethod(
                  NSView.self, #selector(NSView.marvin_setNeedsUpdateConstraints(_:))
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
    /// Public shim so the constraint-storm monitor can write to the same log.
    static func appendPublic(_ entry: String) { append(entry) }

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

// MARK: - Update-constraints pass monitor (ADR-0062 addendum 2)
//
// The 2026-08-18 capture named the non-converging view — the SwiftUI ROOT
// (`AppKitWindowHostingView<ModifiedContent<AnyView, RootModifier>>`,
// needsUpdate=true while all 400 other views had settled) — but not WHO keeps
// dirtying it. The crash log is a post-mortem: by the time it runs, the
// invalidation storm is already over.
//
// This watches `-[NSView setNeedsUpdateConstraints:]` and, once the rate goes
// pathological, records the view, its ancestry, and the CALL STACK of whoever
// asked. That stack is the missing evidence: it names the code path, so the fix
// stops being inferred from view-type names (which is how ADR-0062 previously
// produced two disproved fixes).
//
// Cost when healthy: one integer increment per call. Everything expensive is
// behind the threshold, and the report fires at most once per cooldown so the
// diagnostic can never become the pathology.
extension NSView {
    @objc func marvin_setNeedsUpdateConstraints(_ flag: Bool) {
        if flag { ConstraintStorm.note(self) }
        marvin_setNeedsUpdateConstraints(flag)
    }
}

enum ConstraintStorm {
    /// Invalidations inside one window before we call it a storm. A healthy
    /// layout settles in a handful; the crash needs >401 (one per view) to
    /// trip AppKit's own breaker, so this fires WELL before the fatal pass.
    static let threshold = 150
    /// Rolling window. Normal churn never approaches the threshold this fast.
    static let windowSeconds: CFTimeInterval = 0.5
    /// Don't re-report for this long — the storm is thousands of calls and we
    /// want one readable record, not a self-inflicted flood.
    static let cooldownSeconds: CFTimeInterval = 20

    private static var count = 0
    private static var windowStart: CFTimeInterval = 0
    private static var lastReport: CFTimeInterval = -1000

    /// Hard cap on reports per app launch (ADR-0062 addendum 3).
    ///
    /// The monitor did its job — it named `STTextView`'s per-fragment
    /// `addSubview:` on 2026-08-19 — but it was unbounded, and the storm turned
    /// out to be MARVIN's steady state rather than an occasional event: **966
    /// reports across 2 sessions**, growing the log from 30 KB to **4.4 MB**,
    /// each report paying `Thread.callStackSymbols` symbolication plus a
    /// synchronous write *inside the layout pass*. Past the first few captures
    /// there is nothing new to learn and the instrumentation is pure cost — and
    /// a variable in every subsequent crash report.
    static let maxReportsPerLaunch = 5

    /// Reports carrying a full call stack. The stack is the expensive part and
    /// the first one answers the question; later reports keep the cheap
    /// view/ancestry summary so a CHANGE in trigger is still visible.
    static let maxStacksPerLaunch = 2

    private static var reportsThisLaunch = 0

    /// Hot path: allocation-free, and off after the cap.
    static func note(_ view: NSView) {
        // Off entirely once we have what we need — one branch on an Int.
        if reportsThisLaunch >= maxReportsPerLaunch { return }
        // Statics here are unsynchronised, so confine the whole monitor to the
        // main thread rather than race them. Constraint invalidation during
        // layout is main-thread work; anything else is not what we are hunting.
        guard Thread.isMainThread else { return }
        let now = CACurrentMediaTime()
        if now - windowStart > windowSeconds {
            windowStart = now
            count = 0
        }
        count += 1
        guard count == threshold, now - lastReport > cooldownSeconds else { return }
        lastReport = now
        reportsThisLaunch += 1
        report(view, withStack: reportsThisLaunch <= maxStacksPerLaunch)
    }

    private static func report(_ view: NSView, withStack: Bool) {
        var out = "\n----- constraint storm: \(threshold) invalidations in <\(windowSeconds)s -----\n"
        out += "trigger view: \(type(of: view)) frame=\(view.frame)\n"
        out += "ancestry:\n"
        var node: NSView? = view
        var depth = 0
        while let n = node, depth < 24 {
            out += "  \(String(repeating: " ", count: depth))\(type(of: n)) constraints=\(n.constraints.count)\n"
            node = n.superview
            depth += 1
        }
        if withStack {
            out += "call stack (who asked for the invalidation):\n"
            for frame in Thread.callStackSymbols.prefix(28) {
                out += "    \(frame)\n"
            }
        } else {
            out += "(stack omitted — already captured this launch)\n"
        }
        if reportsThisLaunch == maxReportsPerLaunch {
            out += "(report cap reached; monitor disabled for this launch)\n"
        }
        ExceptionLog.appendPublic(out)
    }
}

/// Counts `NSSplitViewController.loadView` — the experiment's success metric
/// (ADR-0062 addendum 4).
///
/// `loadView` runs ONCE per controller in a healthy app. The 2026-08-22 storm
/// capture caught it inside a 150-invalidations-in-0.5 s burst, which means the
/// split-view subtree was being rebuilt. If the HealthMonitor equality guard is
/// the cause, this count should stay at a small constant for a whole session
/// instead of climbing every ~15 s.
///
/// Logged on a threshold rather than every call so it cannot become the
/// pathology it measures.
enum SplitViewRebuilds {
    private static var count = 0
    /// Report at these counts only — a healthy session should never reach 8.
    private static let reportAt: Set<Int> = [4, 8, 16, 32, 64]

    static func note() {
        guard Thread.isMainThread else { return }
        count += 1
        guard reportAt.contains(count) else { return }
        ExceptionLog.appendPublic(
            "\n----- split-view rebuild #\(count) -----\n"
                + "NSSplitViewController.loadView has run \(count)x this launch. "
                + "Healthy = a small constant. Climbing = the SwiftUI subtree is "
                + "being rebuilt (ADR-0062 addendum 4).\n"
        )
    }
}

extension NSSplitViewController {
    @objc func marvin_loadView() {
        SplitViewRebuilds.note()
        marvin_loadView()
    }
}
