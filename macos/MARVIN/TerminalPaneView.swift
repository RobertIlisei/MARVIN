// TerminalPaneView — a real terminal (ADR-0078).
//
// Until 2026-08-29 this pane ran every command as a fresh `$SHELL -c`
// through the sidecar's `/api/terminal/run` and rendered the SSE stream:
// `cd` never persisted, Ctrl-C did nothing, no colours, no `vim`, and a
// text field under a scrollback that lost focus on every Enter. It is now a
// persistent login shell on a pty (`MARVINLogic/PTYProcess`), rendered by
// SwiftTerm, owned by `TerminalSessionStore` so it survives pane toggles.
//
// IDE conventions kept:
//   • ⌘K clears (Ctrl-L to the shell), Stop sends Ctrl-C
//   • build tasks type into the ACTIVE shell (`bridge.pendingTerminalCommand`)
//   • tabs (2026-09-09): "+" opens another shell, the numbered buttons switch
//     without touching any shell, × on the active tab hangs that one up

import SwiftUI

struct TerminalPaneView: View {
    @State private var focusToken = 0
    @Environment(MarvinBridge.self) private var bridge

    private var store: TerminalSessionStore { TerminalSessionStore.shared }

    /// The ACTIVE tab for the open project, created on first use.
    private var session: TerminalSession? {
        bridge.projectWorkDir.map { store.session(for: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            MarvinDivider()
            if let session {
                PTYTerminalView(session: session, focusToken: focusToken)
            } else {
                Text("Open a project to start a shell.")
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        // BuildTaskSheet injects a command via bridge.pendingTerminalCommand.
        // The store outlives the pane, so a task fired while the pane was
        // hidden lands in the same shell the user sees when it opens.
        .onChange(of: bridge.pendingTerminalCommand, initial: true) { _, cmd in
            guard let cmd, !cmd.isEmpty, let session else { return }
            bridge.consumePendingTerminalCommand()
            session.run(command: cmd)
            // Focus the shell that is now running the job, so ⌃C goes to it.
            focusToken += 1
        }
    }

    /// One button per shell, the active one filled, plus "+". Switching only
    /// swaps which session the pane shows — the shells keep running. The ×
    /// on the active tab is the one act that hangs a shell up.
    private func tabStrip(_ cwd: String) -> some View {
        HStack(spacing: 2) {
            ForEach(store.sessions(for: cwd)) { s in
                let active = store.isActive(s)
                HStack(spacing: 3) {
                    Button {
                        store.activate(s)
                        focusToken += 1
                    } label: {
                        Text("\(s.number)")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(active ? Color.primary : Color.secondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(
                                RoundedRectangle(cornerRadius: 4)
                                    .fill(active ? Color.secondary.opacity(0.18) : Color.clear)
                            )
                    }
                    .buttonStyle(.plain)
                    .help(s.isRunning ? "Shell \(s.number)" : "Shell \(s.number) (exited)")
                    if active && store.sessions(for: cwd).count > 1 {
                        Button {
                            store.close(s)
                            focusToken += 1
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 8, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .help("Close this shell")
                    }
                }
            }
            Button {
                store.newSession(for: cwd)
                focusToken += 1
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .help("New shell")
        }
        .fixedSize()
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("TERMINAL")
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.tertiary)
            if let cwd = bridge.projectWorkDir {
                tabStrip(cwd)
                // `layoutPriority(-1)` is load-bearing, not cosmetic.
                //
                // A project path is long ("/Users/x/Projects/agri-saas-platform"),
                // and with equal priority this Text claimed the row's width and
                // starved the trailing buttons to **0×0**. A SwiftUI Button laid
                // out at zero size does not merely disappear: its AppKit backing
                // re-resolves its style, removes and re-adds its host view, and
                // invalidates constraints — forever. The constraint-storm monitor
                // caught it live on 2026-08-31 at **150 invalidations in under
                // 0.5s**, trigger view `SwiftUIAppKitButton.ContentViewHost
                // frame=(0.0, 0.0, 0.0, 0.0)`, 100% CPU and a 48s hang.
                //
                // It also explains the user report that the Stop/Restart buttons
                // were "missing": they were not missing, they were zero-width.
                // The path yields space first and truncates; the controls keep
                // their intrinsic size.
                Text(cwd)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .layoutPriority(-1)
            } else {
                Text("(no project)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Spacer(minLength: 8)
            if let session {
                if session.isRunning {
                    Button {
                        session.interrupt()
                    } label: {
                        Label("Stop", systemImage: "stop.circle.fill")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.red)
                    .fixedSize()
                    .help("Send Ctrl-C to the shell")
                } else {
                    Button {
                        session.start()
                    } label: {
                        Label("Restart", systemImage: "arrow.clockwise")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.borderless)
                    .fixedSize()
                    .help("Start a new shell")
                }
                Button {
                    session.clear()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("k", modifiers: [.command])
                .fixedSize()
                .help("Clear (⌘K)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}
