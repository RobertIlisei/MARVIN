// TodoStripSnapshot — dev-only rasteriser for the plan checklist strip.
//
// Same contract as MarkdownSnapshot: inert unless `MARVIN_SNAPSHOT_TODO` is
// set to an output path, renders offscreen with no window/session, writes a
// PNG and exits. Added 2026-09-08 to reproduce overlapping row text in the
// strip (user screenshot: a long wrapped sub-task drawn under the next row)
// without iterating blind on screenshots.
//
//     MARVIN_SNAPSHOT_TODO=/tmp/todo.png .build/debug/MARVIN
//     MARVIN_SNAPSHOT_W=990  # optional width override (shared with MD probe)

import AppKit
import MARVINLogic
import SwiftUI

enum TodoStripSnapshot {
    /// Shapes copied from the plan that showed the overlap (agri-saas
    /// "red-main triage"): an in_progress step with activeForm, one long
    /// completed sub-task that must WRAP at the render width, then short
    /// pending rows that must sit BELOW the wrapped text, not on top of it.
    static var sampleSteps: [PlanStep] {
        var triage = PlanStep(
            content: "Triage and fix red main (#2827665106) — first, on its own branch off main.",
            status: "in_progress",
            activeForm: "Triaging red main (#2827665106)"
        )
        triage.subtasks = [
            TodoItem(content: "Pull failing pipeline job logs + JUnit artifacts (done: smoke job, 8 IT failures, 2 root causes identified)",
                     status: "completed", activeForm: nil),
            TodoItem(content: "Root-cause: GRANT agricore_migrator TO agricore_app WITH INHERIT TRUE over-grants (violates ADR-0064 §3 + matview invisibility) — empirically verified INHERIT FALSE, SET TRUE fixes the smoke path with no code change",
                     status: "completed", activeForm: nil),
            TodoItem(content: "Consulting advisor on the corrected fix",
                     status: "pending", activeForm: "Consulting advisor on the corrected fix"),
            TodoItem(content: "Flagging live prod exposure to user",
                     status: "pending", activeForm: nil),
        ]
        return [
            triage,
            PlanStep(content: "ADR — \"App legal surface: versioned legal texts, terms-acceptance ledger, storage preferences\"",
                     status: "pending", activeForm: nil),
            PlanStep(content: "Ship: pr-review + security-audit, commit, push, MR",
                     status: "pending", activeForm: nil),
        ]
    }

    /// Returns true when it handled a snapshot run (caller should exit).
    @MainActor
    static func runIfRequested() -> Bool {
        guard let path = ProcessInfo.processInfo.environment["MARVIN_SNAPSHOT_TODO"],
              !path.isEmpty else { return false }

        let view = TodoListStrip(
            steps: sampleSteps,
            planTitle: "Legal surface for the AgriCore app + red-main triage (pipeline #2827665106)",
            onOpenPlanFile: {},
            onOpenPlansPanel: {},
            onClose: {}
        )
        .frame(width: MarkdownSnapshot.renderWidth)
        .background(Color(nsColor: .windowBackgroundColor))

        let host = NSHostingView(rootView: view)
        host.frame = NSRect(x: 0, y: 0, width: MarkdownSnapshot.renderWidth, height: 10)
        host.layoutSubtreeIfNeeded()
        let fitted = host.fittingSize
        host.frame = NSRect(x: 0, y: 0, width: MarkdownSnapshot.renderWidth,
                            height: max(fitted.height, 10))

        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.setFrameOrigin(NSPoint(x: -10_000, y: -10_000))
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()

        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            FileHandle.standardError.write(Data("todo snapshot: no bitmap rep\n".utf8))
            return true
        }
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) else {
            FileHandle.standardError.write(Data("todo snapshot: render failed\n".utf8))
            return true
        }
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print("todo snapshot written: \(path) (\(Int(host.bounds.width))×\(Int(host.bounds.height)))")
        } catch {
            FileHandle.standardError.write(Data("todo snapshot: \(error)\n".utf8))
        }
        return true
    }
}
