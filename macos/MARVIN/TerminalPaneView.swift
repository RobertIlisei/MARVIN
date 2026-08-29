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
//   • build tasks type into the same shell (`bridge.pendingTerminalCommand`)

import SwiftUI

struct TerminalPaneView: View {
    @Environment(MarvinBridge.self) private var bridge

    private var session: TerminalSession? {
        bridge.projectWorkDir.map { TerminalSessionStore.shared.session(for: $0) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            MarvinDivider()
            if let session {
                PTYTerminalView(session: session)
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
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("TERMINAL")
                .font(.system(size: 9, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.tertiary)
            if let cwd = bridge.projectWorkDir {
                Text(cwd)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.head)
            } else {
                Text("(no project)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            Spacer()
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
                    .help("Send Ctrl-C to the shell")
                } else {
                    Button {
                        session.start()
                    } label: {
                        Label("Restart", systemImage: "arrow.clockwise")
                            .font(.system(size: 11))
                    }
                    .buttonStyle(.borderless)
                    .help("Start a new shell")
                }
                Button {
                    session.clear()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .keyboardShortcut("k", modifiers: [.command])
                .help("Clear (⌘K)")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(nsColor: .underPageBackgroundColor))
    }
}
