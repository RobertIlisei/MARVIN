---
target_identity: "file:/Users/Robert/Documents/MARVIN/.marvin/worktrees/tab-supervisor-chat-m7-4/macos/MARVIN/SupervisorChatView.swift"
target_fingerprint: "sha256:3517dc22e32a87e47de4cf7dc6c57d8c308e7e0b98bbe25ffd45bcb2ccca9b1d"
target_path: /Users/Robert/Documents/MARVIN/.marvin/worktrees/tab-supervisor-chat-m7-4/macos/MARVIN/SupervisorChatView.swift
timestamp: 2026-10-31T19-07-15Z
slug: macos-marvin-supervisorchatview-swift
---
Method: design review only (detector not applicable, native platform)
Target: macos/MARVIN/SupervisorChatView.swift (+ shared cards in SupervisorInboxViews.swift). Renders /tmp/m74-r4, 15 surfaces x 260/420 x light/dark.
Score 31/40 (1:3 2:3 3:3 4:3 5:4 6:3 7:3 8:3 9:3 10:3).
Fixed before scoring: composer opaque block; gutter label wrap; card overflow at 260 (chip row wraps); follow label truncation; dead paused-notice x; duplicate cap notice; orange caption text contrast; placeholder truncation; budget detail truncation; sending caption; paused waiting line; new-tab/guardrail items routed to their own components in chat.
Remaining: P2 raw-act badge orange on every card (polish: neutral). P3 sending composer not dimmed (polish). P3 "Done - Merge ..." grammar (server-text rule, recorded). P3 56 pt gutter at 260 (recorded). P3 9.5 pt guardrail detail (backlog: 11 pt floor). P3 collapsed per-wake line not built (deferred, recorded).
