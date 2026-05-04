"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AdvisorOrb } from "@/components/brain/advisor-orb";
import { BrainLiquid } from "@/components/brain/brain-liquid";
import { ScoutOrb } from "@/components/brain/scout-orb";
import { taskRoleOf } from "@/components/brain/task-role";
import { useChatStream } from "@/components/chat/use-chat-stream";
import { useConfirmTitleBadge } from "@/components/chat/use-confirm-title-badge";
import { VirtualMessageList } from "@/components/chat/virtual-message-list";
import {
  announceBusy,
  announceModels,
  announcePersonality,
  announceProject,
  announceProjects,
  announceSession,
} from "@/lib/marvin-shell";
import { pulseResize } from "@/lib/panel-resize-signal";
import { useMarvinPrefs } from "@/lib/use-prefs";
import { FileTree } from "@/components/file-tree/file-tree";
import { QuickOpen } from "@/components/file-tree/quick-open";

// Lazy-load FileViewer (A3 perf): the wrapper itself is light, but it
// transitively pulls in the Monaco editor ESM wrapper + the unsaved-
// guard, dirty-state, and toolbar modules. Most sessions never open a
// file — deferring the import until `selectedPath` goes truthy saves
// ~60 KB of JS from the critical path. `ssr: false` because Monaco
// requires `window`.
const FileViewer = dynamic(
  () =>
    import("@/components/file-viewer/file-viewer").then((m) => ({
      default: m.FileViewer,
    })),
  { ssr: false },
);

import { GraphPanel } from "@/components/graph/graph-panel";
import { ChatInput } from "@/components/input/chat-input";
import {
  LeftColumnTabs,
  useLeftColumnTab,
} from "@/components/left-column-tabs";
import { PreviewPane } from "@/components/preview/preview-pane";
import { useProjects } from "@/components/project/use-projects";
// Theme + project picker + model picker + permission/personality
// toggles all moved to TopBar; the prefs they mutate now live in
// `useMarvinPrefs()` (Context-backed) so we no longer need to thread
// 18 props through.
import { ModelsDialog } from "@/components/settings/models-dialog";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { ShortcutsHelp } from "@/components/settings/shortcuts-help";
import { ExamplePrompt, labelFor } from "@/components/shell/page-helpers";
import { StatusBar } from "@/components/shell/status-bar";
import { TopBar } from "@/components/shell/top-bar";
import { WorkspaceStatusBar } from "@/components/shell/workspace-status-bar";
import { SourceControlPanel } from "@/components/source-control/source-control-panel";
import { Terminal } from "@/components/terminal/terminal";

// Advisor + scout detection is factored into `taskRoleOf` (see
// components/brain/task-role.ts) so both orbs share one source of truth
// for the description-prefix regex. Adding a third role becomes a
// one-line addition there; this file shouldn't grow its own regex.

// `marvin.session.<projectId>` → the in-flight `marvinSessionId` we
// should try to re-attach to on page refresh. Per-project, so kept
// local rather than folded into the global prefs hook (audit #16).
const LS_SESSION_PREFIX = "marvin.session.";

export default function Home() {
  // Monotonic counter the FileTree subscribes to. Bumped from anywhere
  // the working tree is known to have changed (FS-mutating tool
  // results, git mutations) so the user doesn't have to click refresh
  // after every action. Declared before useChatStream so its
  // onFsMutation callback can reference the bumper synchronously.
  const [fsRefreshTick, setFsRefreshTick] = useState(0);
  const bumpFsRefreshTick = useCallback(() => {
    setFsRefreshTick((t) => t + 1);
  }, []);

  const {
    messages,
    marvinState,
    stats,
    marvinSessionId,
    send,
    cancel,
    retry,
    reset,
    decideConfirm,
    hydrateFromSession,
    attachLive,
  } = useChatStream({ onFsMutation: bumpFsRefreshTick });

  const {
    projects,
    active,
    loading: projectsLoading,
    addProject,
    removeProject,
    selectProject,
    verifyWorkDir,
  } = useProjects();

  const cwd = active?.workDir ?? "";

  // Phase 1d.3 — mirror the active project to the SwiftUI native
  // shell so the NSWindow subtitle can show "$projectName" without
  // duplicating the work the React side already did. No-op outside
  // the Swift shell. Includes workDir so a future native NSToolbar
  // item can render the path on hover without an extra round-trip.
  useEffect(() => {
    announceProject(active?.name ?? null, active?.workDir ?? null);
  }, [active?.name, active?.workDir]);

  // Global prefs from the central context. Replaces five `useState`
  // calls + five persistence effects pre-#25. Each setter persists
  // to localStorage internally — no separate effect needed.
  const {
    prefs,
    setPersonality,
    setPermissionStrategy,
    setModels,
    setPanes,
    togglePane,
    dismissAutoModeBanner,
  } = useMarvinPrefs();
  const {
    personality,
    executorModel,
    advisorModel,
    permissionStrategy,
    panes,
    showAutoModeBanner,
  } = prefs;

  // Phase 1d.15 — mirror the active model selection to the SwiftUI
  // shell. The About panel reads bridge.executorModel / advisorModel
  // and shows them under "Active models". No-op outside the Swift
  // shell. Both nullable to mean "fall back to sidecar default".
  useEffect(() => {
    announceModels(executorModel, advisorModel);
  }, [executorModel, advisorModel]);

  // Phase 1d.32 — mirror the active personality so the About panel
  // can show "marvin" vs "neutral" without the user having to open
  // the web Settings popover.
  useEffect(() => {
    announcePersonality(personality);
  }, [personality]);

  // Phase 1d.33 — mirror the registered project list so the native
  // File → Open Recent submenu can populate. We trim to the three
  // fields the Swift side actually needs; the bridge wire format
  // stays narrow so renaming a ProjectRecord field doesn't break
  // the bridge contract.
  useEffect(() => {
    announceProjects(
      projects.map((p) => ({ id: p.id, name: p.name, workDir: p.workDir })),
    );
  }, [projects]);

  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [leftColumnTab, setLeftColumnTab] = useLeftColumnTab();
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings now shows only the Observability form — the tab argument
  // that callers used to pass is accepted + ignored so existing call
  // sites keep working. Drop the param when we've cleaned them up.
  const openSettings = useCallback((_tab?: string) => {
    setSettingsOpen(true);
  }, []);
  // The Models dialog is separate from Settings (per memory:
  // "MARVIN Settings = Honeycomb only"). Opened from the Setup
  // popover's "Configure" button.
  const [modelsDialogOpen, setModelsDialogOpen] = useState(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [pickerOpenSignal, setPickerOpenSignal] = useState(0);
  const [heroDraft, setHeroDraft] = useState<string>("");
  const [heroDraftKey, setHeroDraftKey] = useState(0);

  // (Persistence used to live here as five separate `useEffect` hooks
  // — one per key, each with its own try/catch swallowing storage
  // errors. They're gone now; `useMarvinPrefs` handles persistence
  // inside its setters. Audit findings #16 + #18.)

  // Clear the file-viewer selection when the active project changes; the
  // previous path is meaningless in a different workDir.
  useEffect(() => {
    setSelectedPath(undefined);
  }, [cwd]);

  // Persist the in-flight marvinSessionId per-project. Survives tab
  // refresh so the resume path knows which turn to attach to.
  useEffect(() => {
    if (!active?.id) return;
    try {
      if (marvinSessionId) {
        localStorage.setItem(
          `${LS_SESSION_PREFIX}${active.id}`,
          marvinSessionId,
        );
      }
    } catch {
      /* no storage */
    }
  }, [marvinSessionId, active?.id]);

  // Phase 2h — mirror (projectId, marvinSessionId) to the SwiftUI
  // shell. The native chat surface uses the pair to hit
  // GET /api/sessions/:id?projectId=… for transcript hydrate and
  // GET /api/chat/resume?marvinSessionId=… to tail a live turn,
  // matching what this component does on mount above. Fires when
  // either side changes; null on either field means "no session
  // available right now" and the native side clears its list.
  useEffect(() => {
    announceSession(active?.id ?? null, marvinSessionId ?? null);
  }, [active?.id, marvinSessionId]);

  // Re-attach to any turn still running on the server after refresh.
  // Runs once per project change: hydrate the transcript, then try to
  // tail a live turn via /api/chat/resume. 204 means "no live turn" and
  // the hydrated transcript is already the final state.
  useEffect(() => {
    if (!active?.id) return;
    let cancelled = false;

    (async () => {
      let storedSid: string | null = null;
      try {
        storedSid = localStorage.getItem(`${LS_SESSION_PREFIX}${active.id}`);
      } catch {
        return;
      }
      if (!storedSid) return;

      // Only attempt resume from a clean empty state — we don't want to
      // overwrite an active session the user already has open.
      if (messages.length > 0) return;

      try {
        const tx = await fetch(
          `/api/sessions/${encodeURIComponent(storedSid)}?projectId=${encodeURIComponent(active.id)}`,
        );
        if (!tx.ok) return;
        const record = await tx.json();
        if (cancelled) return;
        hydrateFromSession(record);
      } catch {
        return;
      }
      if (cancelled) return;

      // Tail the live bus (if the turn is still running).
      await attachLive(storedSid).catch(() => {
        /* 204 or network blip — we already hydrated whatever the
           transcript had; nothing more to do. */
      });
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally exclude `messages` so this effect doesn't retrigger
    // on every chat update; it's a mount-per-project thing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, hydrateFromSession, attachLive]);

  // Sticky-bottom scroll with a 80 px threshold. Pre-fix this effect
  // unconditionally yanked the scroller to the bottom on every
  // messages change — if the user scrolled up to read prior context
  // mid-stream, they'd lose their place each time a new chunk
  // arrived. Audit finding #13.
  //
  // `stickToBottom` flips to false when the user scrolls upward past
  // the threshold; flips back to true when they re-approach the
  // bottom. Streaming content only auto-scrolls while sticky. A
  // "jump to latest" pill renders below when not sticky and new
  // content has arrived.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [hasNewWhileScrolledUp, setHasNewWhileScrolledUp] = useState(false);

  // Track user scroll position; threshold within 80 px of the bottom
  // counts as "still tailing the stream".
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distFromBottom < 80;
      setStickToBottom(atBottom);
      if (atBottom) setHasNewWhileScrolledUp(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on messages change — only while sticky. When not
  // sticky, raise the "new content available" flag so the pill
  // can offer a click-back.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (stickToBottom) {
      el.scrollTop = el.scrollHeight;
    } else {
      setHasNewWhileScrolledUp(true);
    }
  }, [messages, stickToBottom]);

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStickToBottom(true);
    setHasNewWhileScrolledUp(false);
  }, []);

  // Drive the ambient backdrop from MARVIN's current state.
  useEffect(() => {
    document.body.setAttribute("data-marvin", marvinState);
    return () => {
      document.body.setAttribute("data-marvin", "idle");
    };
  }, [marvinState]);

  // Prefix `document.title` with `(N) ` when there are N tool calls
  // waiting on a confirm. Cue is most useful when the tab is hidden
  // — see [docs/reviews/2026-04-26-full-audit.md, finding #11].
  useConfirmTitleBadge(messages);

  // `busy` covers in-flight work; `cancelling` is its own state so the
  // ChatInput can render "stopping…" with a distinct affordance while
  // the /api/chat/cancel call is in flight. Audit finding #22.
  const cancelling = marvinState === "cancelling";
  const busy =
    marvinState !== "idle" &&
    marvinState !== "error" &&
    marvinState !== "cancelling";

  // Phase 1d.20 — mirror busy → SwiftUI menu-bar status item, which
  // swaps between the idle (outlined nodes) and active (filled nodes)
  // Brain Circuit variants. No-op outside the Swift shell. Treat
  // "cancelling" as still busy: the user expects the active state
  // to persist until the stop actually lands.
  useEffect(() => {
    announceBusy(marvinState !== "idle" && marvinState !== "error");
  }, [marvinState]);

  // Phase 1d.25 — listen for native menu-bar commands dispatched by
  // the SwiftUI shell. Each `marvin:<name>` CustomEvent maps to an
  // existing web-side handler so the native menu items don't have
  // to re-implement the action in Swift. No-op outside the Swift
  // shell (the events simply never fire).
  useEffect(() => {
    const onNewSession = () => reset();
    const onOpenProjectPicker = () => setPickerOpenSignal((v) => v + 1);
    const onShowShortcuts = () => setShortcutsOpen(true);
    const onToggleTheme = () => {
      const current = document.documentElement.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";
      if (next === "dark") {
        document.documentElement.setAttribute("data-theme", "dark");
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
      try {
        localStorage.setItem("marvin-theme", next);
      } catch {
        /* no storage — stays in-memory for the session */
      }
    };

    // Phase 1d.29 — drag a folder from Finder onto the WebView and
    // it becomes a MARVIN project. The native side validates the
    // path is a directory before dispatching; we just hand it to
    // the existing addProject handler, which runs the manifest /
    // CLAUDE.md sniff and persists. setActive: true so the user
    // sees the project become active on drop without an extra
    // click.
    const onDroppedFolder = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { path?: string; name?: string }
        | undefined;
      if (!detail?.path) return;
      void addProject({
        workDir: detail.path,
        name: detail.name,
        setActive: true,
      });
    };

    // Phase 1d.33 — File → Open Recent → <project> in the native
    // menu bar dispatches `marvin:select-project` with the project
    // id. selectProject is the same call the web picker uses, so
    // the resulting state transition is identical.
    const onSelectProject = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { id?: string }
        | undefined;
      if (!detail?.id) return;
      void selectProject(detail.id);
    };

    // Phase 3c — clicking a row in the native file tree dispatches
    // `marvin:select-file` with the absolute path. The web side
    // reuses its existing setSelectedPath state, which the existing
    // FileViewer (Monaco) already consumes — so the file opens in
    // the same surface a web tree click would have opened it in.
    // No path validation here because the native side gets paths
    // straight from /api/files/tree, which the sandbox already
    // checked.
    const onSelectFile = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { path?: string }
        | undefined;
      if (!detail?.path) return;
      setSelectedPath(detail.path);
    };

    window.addEventListener("marvin:new-session", onNewSession);
    window.addEventListener("marvin:open-project-picker", onOpenProjectPicker);
    window.addEventListener("marvin:show-shortcuts", onShowShortcuts);
    window.addEventListener("marvin:toggle-theme", onToggleTheme);
    window.addEventListener("marvin:dropped-folder", onDroppedFolder);
    window.addEventListener("marvin:select-project", onSelectProject);
    window.addEventListener("marvin:select-file", onSelectFile);
    return () => {
      window.removeEventListener("marvin:new-session", onNewSession);
      window.removeEventListener("marvin:open-project-picker", onOpenProjectPicker);
      window.removeEventListener("marvin:show-shortcuts", onShowShortcuts);
      window.removeEventListener("marvin:toggle-theme", onToggleTheme);
      window.removeEventListener("marvin:dropped-folder", onDroppedFolder);
      window.removeEventListener("marvin:select-project", onSelectProject);
      window.removeEventListener("marvin:select-file", onSelectFile);
    };
  }, [reset, addProject, selectProject]);

  const handleSend = useCallback(
    (text: string) => {
      if (!cwd) return;
      send(text, cwd, {
        personality,
        permissionStrategy,
        model: executorModel,
        advisorModel,
      });
    },
    [send, cwd, personality, permissionStrategy, executorModel, advisorModel],
  );

  // `togglePane` comes from the prefs context above; the previous
  // local useCallback wrapper around `setPanes` was redundant once
  // the hook owned the shape.

  // ---- Global keyboard shortcuts ---------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when the user is typing in a text field.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (target?.isContentEditable ?? false);

      if (e.key === "Escape") {
        if (quickOpenOpen) setQuickOpenOpen(false);
        else if (shortcutsOpen) setShortcutsOpen(false);
        return;
      }

      if (e.key === "?" && !isEditable && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Cmd+K — open project picker
      if (e.key === "k" && !e.shiftKey) {
        e.preventDefault();
        setPickerOpenSignal((v) => v + 1);
        return;
      }
      // Cmd+Shift+N — new session
      if (e.key === "N" && e.shiftKey) {
        e.preventDefault();
        reset();
        return;
      }
      // Cmd+B — toggle files
      if (e.key === "b" && !e.shiftKey) {
        e.preventDefault();
        togglePane("files");
        return;
      }
      // Cmd+G — toggle graph
      if (e.key === "g" && !e.shiftKey) {
        e.preventDefault();
        togglePane("graph");
        return;
      }
      // Cmd+J — toggle terminal
      if (e.key === "j" && !e.shiftKey) {
        e.preventDefault();
        togglePane("terminal");
        return;
      }
      // Cmd+P — file quick-open (IDE muscle memory)
      if (e.key === "p" && !e.shiftKey) {
        e.preventDefault();
        if (cwd) setQuickOpenOpen(true);
        return;
      }
      // Cmd+Shift+P — toggle preview (moved from ⌘P to make room for quick-open)
      if ((e.key === "P" || e.key === "p") && e.shiftKey) {
        e.preventDefault();
        togglePane("preview");
        return;
      }
      // Cmd+. (period) — cancel the running turn
      if (e.key === ".") {
        e.preventDefault();
        cancel();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutsOpen, quickOpenOpen, reset, togglePane, cancel, cwd]);

  const handleResumeSession = useCallback(
    async (projectId: string, sessionId: string) => {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(projectId)}`,
        );
        if (!res.ok) return;
        const record = await res.json();
        hydrateFromSession(record);
      } catch {
        /* ignore */
      }
    },
    [hydrateFromSession],
  );

  // Bump cost pill after every completed turn.
  useEffect(() => {
    if (stats?.costUsd != null) setSessionRefreshKey((v) => v + 1);
  }, [stats]);

  const isEmpty = messages.length === 0;
  const hint = active ? undefined : "pick a project up in the header first";

  // Companion orbs fire when any in-flight Task subagent carries a
  // sanctioned role prefix on its description — "advisor:" (ADR-0007)
  // or "scout:" (ADR-0014). The SDK's `advisorModel` option is
  // server-side routing only; `tool_use name === "advisor"` never
  // fires. The role lives in the `description` field, which is what
  // personality.ts tells MARVIN to set.
  //
  // Walk messages once and emit both roles' {active, topic} in a
  // single pass — same O(n) as the previous two-`some()`-calls
  // version, half the iteration. Newest → oldest so the first match
  // per role is the most recent active one, which is the topic that
  // should light the caption.
  const { advisorActive, advisorTopic, scoutActive, scoutTopic } = useMemo(() => {
    let aActive = false;
    let sActive = false;
    let aTopic: string | null = null;
    let sTopic: string | null = null;
    outer: for (let mi = messages.length - 1; mi >= 0; mi--) {
      const msg = messages[mi];
      if (!msg) continue;
      for (let bi = msg.blocks.length - 1; bi >= 0; bi--) {
        const block = msg.blocks[bi];
        if (
          !block ||
          block.type !== "tool_use" ||
          block.name !== "Task" ||
          block.running !== true
        ) {
          continue;
        }
        const role = taskRoleOf(block.input);
        if (!role) continue;
        if (role.role === "advisor" && !aActive) {
          aActive = true;
          aTopic = role.topic || null;
        } else if (role.role === "scout" && !sActive) {
          sActive = true;
          sTopic = role.topic || null;
        }
        if (aActive && sActive) break outer;
      }
    }
    return {
      advisorActive: aActive,
      advisorTopic: aTopic,
      scoutActive: sActive,
      scoutTopic: sTopic,
    };
  }, [messages]);

  // --- Header ------------------------------------------------------------
  // `<TopBar>` lives at components/shell/top-bar.tsx (extracted as
  // part of the A2 decomposition pass). The prop bag is explicit
  // because the header reads from ~18 state values scattered across
  // Home; promoting to a Context is tempting but premature.
  const topBar = (
    <TopBar
      isEmpty={isEmpty}
      onReset={reset}
      projects={projects}
      active={active}
      projectsLoading={projectsLoading}
      onSelectProject={selectProject}
      onRemoveProject={removeProject}
      onAddProject={addProject}
      verifyWorkDir={verifyWorkDir}
      onResumeSession={handleResumeSession}
      pickerOpenSignal={pickerOpenSignal}
      sessionRefreshKey={sessionRefreshKey}
      permissionStrategy={permissionStrategy}
      onPermissionStrategyChange={setPermissionStrategy}
      executorModel={executorModel}
      advisorModel={advisorModel}
      onOpenModelsDialog={() => setModelsDialogOpen(true)}
      personality={personality}
      onPersonalityChange={setPersonality}
      panes={panes}
      onTogglePane={togglePane}
      cwd={cwd}
      onOpenSettings={openSettings}
      onOpenShortcuts={() => setShortcutsOpen(true)}
    />
  );


  if (isEmpty) {
    const fillDraft = (text: string) => {
      setHeroDraft(text);
      setHeroDraftKey((v) => v + 1);
    };
    return (
      <main className="relative flex h-screen w-screen flex-col overflow-hidden">
        {/* Ambient constellation layer — only on the hero canvas */}
        <div aria-hidden className="constellation" />
        {topBar}
        {/* Audit finding #2: first-run banner explaining `auto`
            permission strategy = full bypass. Renders only when:
            (a) the user is on the empty state (so they're about to
            start their first turn), (b) permissions are still on the
            default `auto`, and (c) they haven't dismissed yet. The
            dismiss action persists across resets so the user only
            sees this once. */}
        {showAutoModeBanner && permissionStrategy === "auto" && (
          <div
            role="status"
            aria-label="auto mode warning"
            className="border-b border-[color:var(--color-warn)]/40 bg-[color:var(--color-warn)]/10 px-6 py-2.5 text-[color:var(--color-fg)]/95"
          >
            <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 text-[12px] leading-relaxed">
              <span
                aria-hidden
                className="rounded-full bg-[color:var(--color-warn)] px-2 py-px font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-bg)]"
              >
                heads up
              </span>
              <span className="flex-1">
                MARVIN is in <strong>auto mode</strong> — file edits and
                shell commands run without a confirm prompt. A short
                hard-deny list still blocks the obvious footguns
                (<code className="font-mono text-[11px]">rm -rf /</code>,{" "}
                <code className="font-mono text-[11px]">git push --force</code>
                , etc.) and every auto-allowed action is logged to{" "}
                <code className="font-mono text-[11px]">
                  &lt;project&gt;/.marvin/auto-audit.jsonl
                </code>
                . Switch to <strong>gated</strong> in setup if you'd
                rather review each call.
              </span>
              <button
                type="button"
                onClick={dismissAutoModeBanner}
                className="rounded-md border border-[color:var(--color-border-strong)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-fg)] hover:text-[color:var(--color-fg)]"
              >
                got it
              </button>
            </div>
          </div>
        )}
        <div className="scroll-thin relative flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-6 py-6">
          <div className="flex w-full max-w-5xl flex-col items-center gap-6 pt-4">
            <div className="grid w-full grid-cols-1 items-center gap-10 md:grid-cols-[auto_1fr]">
              {/* BrainLiquid is the centerpiece — kept exactly as-is per
                  user feedback (see ~/.marvin memory: "BrainLiquid is
                  sacred"). The hero-orbit container, particle profile,
                  and orb sizes are unchanged. The trimming pass only
                  drops the *surrounding* chrome — coordinate marks,
                  capability chips, status chip, blockquote — that the
                  audit (finding #10) found drowned the brain in
                  decoration. */}
              {/* Hero orbit container is sized to fit BrainLiquid's full
                  layout block, which is `size * RENDER_SCALE` (1.5×).
                  At size=340 the wrapper is 510, so the orbit needs
                  ≥520 to leave a few px of breathing room for the
                  AdvisorOrb/ScoutOrb satellite offsets. */}
              <div className="hero-orbit hero-brain-intro relative flex h-[540px] w-[540px] items-center justify-center md:h-[560px] md:w-[560px]">
                {/* Landing hero: cycle through every state on its
                    own so the brain has presence even when there's
                    no real session driving it. The project-page
                    BrainLiquid below stays prop-driven. */}
                <BrainLiquid state={marvinState} size={340} autoCycle />
                <AdvisorOrb
                  active={advisorActive}
                  model={advisorModel}
                  topic={advisorTopic}
                  size={88}
                  offset={{ top: 20, right: 0 }}
                />
                <ScoutOrb
                  active={scoutActive}
                  topic={scoutTopic}
                  size={88}
                  offset={{ top: 20, left: 0 }}
                />
              </div>
              <div className="flex flex-col gap-4 text-center md:text-left">
                {/* `title` carries the long-form tagline + the
                    Hitchhiker's-Guide quote that previously rendered as
                    standalone elements (mono tagline strip + glass
                    blockquote). They're discoverable via hover/focus
                    on the wordmark; can upgrade to a real Tooltip
                    primitive later if the hover affordance proves too
                    quiet. */}
                <h1
                  title={
                    "Moderately Advanced Robotic Virtual Intelligence Network.\n\n" +
                    "“Here I am, brain the size of a planet, and they ask me to build a login page. Fine. Reading your codebase…”"
                  }
                  className="hero-stage-2 title-glow font-display text-7xl italic leading-[0.88] tracking-tight text-[color:var(--color-accent)] md:text-[108px]"
                >
                  marvin<span className="text-[color:var(--color-accent-deep)]/70">.</span>
                </h1>
                <p className="hero-stage-3 max-w-xl text-[15px] leading-relaxed text-[color:var(--color-fg-dim)] md:text-base">
                  Brain the size of a planet — reads your codebase,
                  drafts a plan, writes the diff, runs the tools. Ask
                  anyway.
                </p>
              </div>
            </div>

          </div>
        </div>

        {/* Example prompts moved out of the brain row and into the
            chat-input column so they visually pair with the chat
            box rather than competing with the brain for vertical
            space. Same `max-w-3xl` width as ChatInput to align. */}
        <div data-marvin-chat-pane className="mx-auto w-full max-w-3xl px-6 pb-3">
          <div className="hero-stage-4 grid w-full grid-cols-1 gap-3 md:grid-cols-3">
            <ExamplePrompt
              title="explain the architecture"
              body="walk me through the structure of this repo and how the major pieces connect"
              onUse={fillDraft}
              disabled={!cwd}
            />
            <ExamplePrompt
              title="find the hot paths"
              body="show me where the main turn loop could race or drop events, and propose tests that would catch it"
              onUse={fillDraft}
              disabled={!cwd}
            />
            <ExamplePrompt
              title="ship a feature"
              body="add a command palette (⌘K) that surfaces recent sessions, shortcuts, and panes"
              onUse={fillDraft}
              disabled={!cwd}
            />
          </div>
        </div>

        <div data-marvin-chat-pane className="mx-auto w-full max-w-3xl px-6 pb-8">
          <ChatInput
            onSend={handleSend}
            onCancel={cancel}
            busy={busy}
            cancelling={cancelling}
            disabled={!cwd}
            hint={hint}
            draft={heroDraft}
            draftKey={heroDraftKey}
          />
        </div>
        <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </main>
    );
  }

  const showFiles = panes.files && !!cwd;
  const showBrain = panes.brain;
  const showGraph = panes.graph && !!cwd;
  const showPreview = panes.preview && !!cwd;
  const showFileViewer = Boolean(selectedPath && cwd);
  const showTerminal = Boolean(panes.terminal && cwd);
  const hasWork =
    showPreview || showGraph || showFileViewer || showTerminal;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden">
      {topBar}
      <PanelGroup
        direction="horizontal"
        autoSaveId="marvin-shell-h-v3"
        className="min-h-0 flex-1 w-full"
        onLayout={pulseResize}
      >
        {showFiles && (
          <>
            <Panel
              id="tree"
              order={1}
              defaultSize={17}
              minSize={10}
              maxSize={28}
              className="hidden lg:block"
              data-marvin-file-tree
            >
              <aside className="flex h-full flex-col border-r border-[color:var(--color-border)] bg-[color:var(--material-sidebar)]">
                <LeftColumnTabs
                  tab={leftColumnTab}
                  onTabChange={setLeftColumnTab}
                />
                <div className="min-h-0 flex-1">
                  {leftColumnTab === "files" ? (
                    <FileTree
                      cwd={cwd}
                      onSelect={setSelectedPath}
                      {...(selectedPath ? { selectedPath } : {})}
                      onOpenInTerminal={() =>
                        setPanes((p) => ({ ...p, terminal: true }))
                      }
                      externalRefresh={fsRefreshTick}
                    />
                  ) : (
                    <SourceControlPanel
                      cwd={cwd}
                      visible={leftColumnTab === "source-control"}
                      selectedPath={selectedPath ?? null}
                      onSelect={setSelectedPath}
                      onMutation={bumpFsRefreshTick}
                    />
                  )}
                </div>
                {/* VSCode / Cursor parity: footer strip with workspace
                 * name + git branch + dirty / ahead / behind. Clicking
                 * the branch switches the left tab to Source Control
                 * so the branch switcher is one gesture away. */}
                <WorkspaceStatusBar
                  cwd={cwd || null}
                  projectName={active?.name ?? null}
                  onSwitchToSourceControl={setLeftColumnTab}
                />
              </aside>
            </Panel>
            <PanelResizeHandle
              className="hidden w-px bg-[color:var(--color-border)] transition hover:w-[3px] hover:bg-[color:var(--color-accent-deep)]/40 lg:block"
              data-marvin-file-tree
            />
          </>
        )}

        <Panel id="center" order={2} defaultSize={46} minSize={24}>
          <section className="flex h-full min-w-0 flex-col">
            {hasWork ? (
              (() => {
                // Build the center panes in display order so resize handles
                // only render between adjacent panes (avoids a dangling
                // handle when the top slot is empty).
                const panesList: ReactNode[] = [];
                let order = 1;
                if (showPreview) {
                  panesList.push(
                    <Panel
                      key="preview"
                      id="preview"
                      order={order++}
                      defaultSize={35}
                      minSize={15}
                    >
                      <PreviewPane projectId={active?.id ?? null} />
                    </Panel>,
                  );
                }
                if (showGraph) {
                  panesList.push(
                    <Panel
                      key="graph"
                      id="graph"
                      order={order++}
                      defaultSize={45}
                      minSize={20}
                    >
                      <div className="h-full border-t border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/20">
                        <GraphPanel cwd={cwd} />
                      </div>
                    </Panel>,
                  );
                }
                if (showFileViewer) {
                  panesList.push(
                    <Panel
                      key="file-viewer"
                      id="file-viewer"
                      order={order++}
                      defaultSize={50}
                      minSize={15}
                    >
                      <FileViewer
                        cwd={cwd}
                        filePath={selectedPath!}
                        onClose={() => setSelectedPath(undefined)}
                      />
                    </Panel>,
                  );
                }
                if (showTerminal) {
                  panesList.push(
                    <Panel
                      key="terminal"
                      id="terminal"
                      order={order++}
                      defaultSize={30}
                      minSize={15}
                    >
                      <Terminal cwd={cwd} />
                    </Panel>,
                  );
                }
                const withHandles: ReactNode[] = [];
                for (let i = 0; i < panesList.length; i++) {
                  if (i > 0) {
                    withHandles.push(
                      <PanelResizeHandle
                        key={`h-${i}`}
                        className="h-px bg-[color:var(--color-border)] transition hover:h-[3px] hover:bg-[color:var(--color-accent-deep)]/40"
                      />,
                    );
                  }
                  withHandles.push(panesList[i]);
                }
                return (
                  <PanelGroup
                    direction="vertical"
                    autoSaveId="marvin-center-v-v4"
                    className="flex-1"
                    onLayout={pulseResize}
                  >
                    {withHandles}
                  </PanelGroup>
                );
              })()
            ) : (
              <div className="flex h-full flex-1 items-center justify-center px-6 py-10 text-center">
                <div className="max-w-sm font-mono text-[11px] text-[color:var(--color-fg-faint)]">
                  <div className="mb-2 text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-dim)]">
                    work pane
                  </div>
                  <p className="leading-relaxed">
                    open a file from the tree, reveal a terminal
                    (<span className="text-[color:var(--color-fg)]/80">⌘ J</span>),
                    the preview
                    (<span className="text-[color:var(--color-fg)]/80">⌘ P</span>),
                    or the graph
                    (<span className="text-[color:var(--color-fg)]/80">⌘ G</span>)
                    to work here. chat is on the right.
                  </p>
                </div>
              </div>
            )}
          </section>
        </Panel>

        <PanelResizeHandle className="hidden w-px bg-[color:var(--color-border)] transition hover:w-[3px] hover:bg-[color:var(--color-accent-deep)]/40 md:block" />
        <Panel
          id="side"
          order={3}
          defaultSize={37}
          minSize={24}
          maxSize={55}
          className="hidden md:block"
        >
          <aside className="flex h-full min-h-0 flex-col border-l border-[color:var(--color-border)] bg-[color:var(--material-sidebar)]">
            <PanelGroup
              direction="vertical"
              autoSaveId="marvin-side-v-v2"
              className="flex-1"
              onLayout={pulseResize}
            >
              {showBrain && (
                <>
                  <Panel
                    id="side-top"
                    order={1}
                    defaultSize={38}
                    minSize={18}
                    maxSize={65}
                  >
                    <div className="flex h-full min-h-0 flex-col items-center justify-center bg-gradient-to-b from-transparent via-[color:var(--color-bg-elev)]/30 to-transparent px-6 py-6">
                      {/* Brain + state indicator only. Project / executor /
                       * advisor live in the header; Honeycomb moved to
                       * Settings → Observability. The brain panel stays
                       * visually quiet so the animated state pulls focus. */}
                      <div className="relative flex flex-col items-center gap-3">
                        <BrainLiquid state={marvinState} size={200} />
                        <AdvisorOrb
                          active={advisorActive}
                          model={advisorModel}
                          topic={advisorTopic}
                          size={56}
                          offset={{ top: 0, right: -12 }}
                        />
                        <ScoutOrb
                          active={scoutActive}
                          topic={scoutTopic}
                          size={56}
                          offset={{ top: 0, left: -12 }}
                        />
                        <div className="text-center">
                          <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
                            state
                          </div>
                          <div className="mt-0.5 font-mono text-sm text-[color:var(--color-accent)]">
                            {labelFor(marvinState)}
                          </div>
                        </div>
                      </div>
                    </div>
                  </Panel>
                  <PanelResizeHandle className="h-px bg-[color:var(--color-border)] transition hover:h-[3px] hover:bg-[color:var(--color-accent-deep)]/40" />
                </>
              )}
              <Panel id="side-chat" order={2} minSize={20}>
                <div data-marvin-chat-pane className="flex h-full min-h-0 flex-col">
                  <div className="px-4 pt-3">
                    <StatusBar
                      state={marvinState}
                      stats={stats}
                      marvinSessionId={marvinSessionId}
                    />
                  </div>
                  <div className="relative min-h-0 flex-1">
                    <div
                      ref={scrollerRef}
                      className="scroll-thin h-full overflow-y-auto px-4 py-4"
                    >
                      <div className="flex flex-col gap-4">
                        <VirtualMessageList
                          messages={messages}
                          onDecideConfirm={decideConfirm}
                          onRetry={retry}
                        />
                      </div>
                    </div>
                    {/* "Jump to latest" pill — only renders when the
                        user has scrolled up AND new content has
                        arrived since. Click snaps to bottom and
                        re-engages sticky-tail. Audit finding #13. */}
                    {!stickToBottom && hasNewWhileScrolledUp && (
                      <button
                        type="button"
                        onClick={jumpToLatest}
                        className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-accent)] shadow-md transition hover:border-[color:var(--color-accent-deep)]"
                      >
                        ↓ jump to latest
                      </button>
                    )}
                  </div>
                  <div className="px-4 pb-4">
                    <ChatInput
                      onSend={handleSend}
                      onCancel={cancel}
                      busy={busy}
                      cancelling={cancelling}
                      disabled={!cwd}
                      hint={hint}
                    />
                  </div>
                </div>
              </Panel>
            </PanelGroup>
          </aside>
        </Panel>
      </PanelGroup>
      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {cwd && (
        <QuickOpen
          cwd={cwd}
          open={quickOpenOpen}
          onOpenChange={setQuickOpenOpen}
          onSelect={(absPath) => setSelectedPath(absPath)}
        />
      )}
      <SettingsPanel
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        cwd={cwd || null}
      />
      <ModelsDialog
        open={modelsDialogOpen}
        onOpenChange={setModelsDialogOpen}
        executor={executorModel}
        advisor={advisorModel}
        onChange={setModels}
      />
    </main>
  );
}

// A2 decomposition: `LabeledGroup`, `PaneToggle`, `Capability`,
// `ExamplePrompt`, and `labelFor` moved to
// apps/web/src/components/shell/page-helpers.tsx. Pure JSX + props
// with no state/effects — safe to extract without behaviour change.
