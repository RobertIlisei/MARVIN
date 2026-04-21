"use client";

import dynamic from "next/dynamic";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { AdvisorOrb } from "@/components/brain/advisor-orb";
import { BrainLiquid } from "@/components/brain/brain-liquid";
import { MessageView } from "@/components/chat/message-view";
import { useChatStream } from "@/components/chat/use-chat-stream";
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
// `PermissionStrategy` and `PersonalityMode` are still used by
// useState<> generics below; the actual toggle components live in
// TopBar. ThemeToggle, ModelPicker, BranchBadge, ProjectPicker,
// CostPill likewise moved to TopBar.
import type { PermissionStrategy } from "@/components/settings/permission-toggle";
import type { PersonalityMode } from "@/components/settings/personality-toggle";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { ShortcutsHelp } from "@/components/settings/shortcuts-help";
import {
  Capability,
  ExamplePrompt,
  labelFor,
} from "@/components/shell/page-helpers";
import { StatusBar } from "@/components/shell/status-bar";
import { TopBar } from "@/components/shell/top-bar";
import { WorkspaceStatusBar } from "@/components/shell/workspace-status-bar";
import { SourceControlPanel } from "@/components/source-control/source-control-panel";
import { Terminal } from "@/components/terminal/terminal";

/** Match Task `input` shapes whose description marks an advisor consult. */
function advisorDescriptionOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const d = (input as { description?: unknown }).description;
  return typeof d === "string" ? d : null;
}

function looksLikeAdvisorConsult(input: unknown): boolean {
  const desc = advisorDescriptionOf(input);
  return desc != null && /^\s*advisor[\s:—-]/i.test(desc);
}

function stripAdvisorPrefix(desc: string): string {
  return desc.replace(/^\s*advisor[\s:—-]+/i, "").trim();
}

const LS_PERSONALITY_KEY = "marvin.personality";
const LS_MODEL_EXECUTOR_KEY = "marvin.model.executor";
const LS_MODEL_ADVISOR_KEY = "marvin.model.advisor";
const LS_PERMISSION_KEY = "marvin.permissionStrategy";
const LS_PANES_KEY = "marvin.panes"; // { files, brain, graph, terminal }
// `marvin.session.<projectId>` → the in-flight `marvinSessionId` we
// should try to re-attach to on page refresh.
const LS_SESSION_PREFIX = "marvin.session.";

interface PaneState {
  files: boolean;
  brain: boolean;
  graph: boolean;
  preview: boolean;
  terminal: boolean;
}

const DEFAULT_PANES: PaneState = {
  files: true,
  brain: true,
  graph: false,
  preview: false,
  terminal: false,
};

export default function Home() {
  const {
    messages,
    marvinState,
    stats,
    marvinSessionId,
    send,
    cancel,
    reset,
    decideConfirm,
    hydrateFromSession,
    attachLive,
  } = useChatStream();

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

  const [personality, setPersonality] = useState<PersonalityMode>("marvin");
  const [executorModel, setExecutorModel] = useState<string | null>(null);
  const [advisorModel, setAdvisorModel] = useState<string | null>(null);
  const [permissionStrategy, setPermissionStrategy] =
    useState<PermissionStrategy>("auto");
  const [panes, setPanes] = useState<PaneState>(DEFAULT_PANES);
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
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [pickerOpenSignal, setPickerOpenSignal] = useState(0);
  const [heroDraft, setHeroDraft] = useState<string>("");
  const [heroDraftKey, setHeroDraftKey] = useState(0);

  useEffect(() => {
    try {
      const p = localStorage.getItem(LS_PERSONALITY_KEY);
      if (p === "marvin" || p === "neutral") setPersonality(p);
      const em = localStorage.getItem(LS_MODEL_EXECUTOR_KEY);
      if (em) setExecutorModel(em);
      const am = localStorage.getItem(LS_MODEL_ADVISOR_KEY);
      if (am) setAdvisorModel(am);
      const perm = localStorage.getItem(LS_PERMISSION_KEY);
      if (perm === "auto" || perm === "gated") setPermissionStrategy(perm);
      const raw = localStorage.getItem(LS_PANES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PaneState>;
        setPanes((prev) => ({ ...prev, ...parsed }));
      }
    } catch {
      /* no storage */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_PERSONALITY_KEY, personality);
    } catch {
      /* no storage */
    }
  }, [personality]);

  useEffect(() => {
    try {
      if (executorModel) localStorage.setItem(LS_MODEL_EXECUTOR_KEY, executorModel);
      else localStorage.removeItem(LS_MODEL_EXECUTOR_KEY);
    } catch {
      /* no storage */
    }
  }, [executorModel]);

  useEffect(() => {
    try {
      if (advisorModel) localStorage.setItem(LS_MODEL_ADVISOR_KEY, advisorModel);
      else localStorage.removeItem(LS_MODEL_ADVISOR_KEY);
    } catch {
      /* no storage */
    }
  }, [advisorModel]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_PERMISSION_KEY, permissionStrategy);
    } catch {
      /* no storage */
    }
  }, [permissionStrategy]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_PANES_KEY, JSON.stringify(panes));
    } catch {
      /* no storage */
    }
  }, [panes]);

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

  const scrollerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Drive the ambient backdrop from MARVIN's current state.
  useEffect(() => {
    document.body.setAttribute("data-marvin", marvinState);
    return () => {
      document.body.setAttribute("data-marvin", "idle");
    };
  }, [marvinState]);

  const busy =
    marvinState !== "idle" && marvinState !== "error";

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

  const togglePane = useCallback(
    (key: keyof PaneState) => setPanes((p) => ({ ...p, [key]: !p[key] })),
    [],
  );

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

  // Advisor is "firing" when any in-flight tool call is a Task subagent
  // whose description starts with "advisor" — MARVIN's userland advisor
  // pattern (see ADR-0007). The leading "advisor:" prefix on the
  // description is the UI contract defined in personality.ts under
  // "Advisor consult — how to run one".
  //
  // NOTE: we do NOT look for a tool named "advisor" directly — the SDK's
  // `advisorModel` option is server-side routing and doesn't register a
  // callable tool. Looking for `name === "advisor"` would never match.
  const advisorActive = useMemo(
    () =>
      messages.some((m) =>
        m.blocks.some(
          (b) =>
            b.type === "tool_use" &&
            b.name === "Task" &&
            b.running === true &&
            looksLikeAdvisorConsult(b.input),
        ),
      ),
    [messages],
  );

  // Latest Task description starting with "advisor" — surfaces the
  // consult topic in the orb caption.
  const advisorTopic = useMemo(() => {
    for (let mi = messages.length - 1; mi >= 0; mi--) {
      const msg = messages[mi];
      if (!msg) continue;
      for (let bi = msg.blocks.length - 1; bi >= 0; bi--) {
        const block = msg.blocks[bi];
        if (
          block &&
          block.type === "tool_use" &&
          block.name === "Task" &&
          block.running === true &&
          looksLikeAdvisorConsult(block.input)
        ) {
          const desc = advisorDescriptionOf(block.input);
          return desc ? stripAdvisorPrefix(desc) : null;
        }
      }
    }
    return null;
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
      onModelsChange={({ executor, advisor }) => {
        setExecutorModel(executor);
        setAdvisorModel(advisor);
      }}
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
        <div className="scroll-thin relative flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-6 py-6">
          <div className="flex w-full max-w-5xl flex-col items-center gap-6 pt-4">
            <div className="grid w-full grid-cols-1 items-center gap-10 md:grid-cols-[auto_1fr]">
              <div className="hero-orbit hero-brain-intro relative flex h-[420px] w-[420px] items-center justify-center md:h-[460px] md:w-[460px]">
                <BrainLiquid state={marvinState} size={340} />
                <AdvisorOrb
                  active={advisorActive}
                  model={advisorModel}
                  topic={advisorTopic}
                  size={88}
                  offset={{ top: 20, right: 0 }}
                />
                {/* Coordinate marks — editorial instrument framing */}
                <div
                  aria-hidden
                  className="font-mono pointer-events-none absolute -top-1 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.45em] text-[color:var(--color-fg-faint)]/70"
                >
                  ✦ m·a·r·v·i·n
                </div>
                <div
                  aria-hidden
                  className="font-mono pointer-events-none absolute bottom-0 left-1/2 -translate-x-1/2 text-[9px] uppercase tracking-[0.45em] text-[color:var(--color-fg-faint)]/70"
                >
                  declination · 00°00′
                </div>
              </div>
              <div className="flex flex-col gap-4 text-center md:text-left">
                <div className="hero-stage-1 flex items-center justify-center gap-2 font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)] md:justify-start">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[color:var(--color-accent)] shadow-[0_0_10px_var(--color-accent)]" />
                  <span>online · {labelFor(marvinState)}</span>
                  <span className="text-[color:var(--color-fg-faint)]/60">·</span>
                  <span>log {new Date().toISOString().slice(0, 10)}</span>
                </div>
                <h1 className="hero-stage-2 title-glow font-display text-7xl italic leading-[0.88] tracking-tight text-[color:var(--color-accent)] md:text-[108px]">
                  marvin<span className="text-[color:var(--color-accent-deep)]/70">.</span>
                </h1>
                <div className="hero-stage-3 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)] md:justify-start">
                  <span className="h-px w-6 bg-[color:var(--color-accent-deep)]/50" />
                  <span>Moderately Advanced Robotic Virtual Intelligence Network</span>
                </div>
                <p className="hero-stage-3 max-w-xl text-[15px] leading-relaxed text-[color:var(--color-fg-dim)] md:text-base">
                  The layer between you and a model that reads your codebase,
                  drafts a plan, writes the diff, and runs the tools.
                  Brain the size of a planet. Ask anyway.
                </p>
                <div className="hero-stage-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Capability
                    label="reads code"
                    hint="indexes + queries your repo"
                  />
                  <Capability
                    label="plans first"
                    hint="structural confirm gate"
                  />
                  <Capability
                    label="writes diffs"
                    hint="monaco diff viewer"
                  />
                  <Capability
                    label="runs tools"
                    hint="shell, git, tests"
                  />
                </div>
              </div>
            </div>

            <div className="hero-stage-4 grid w-full grid-cols-1 gap-3 md:grid-cols-3">
              <ExamplePrompt
                title="explain the architecture"
                body="walk me through the top 5 god nodes in this codebase and how they connect"
                onUse={fillDraft}
                disabled={!cwd}
              />
              <ExamplePrompt
                title="find a bug"
                body="something is off with the chat stream — messages sometimes arrive twice. investigate."
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

            <blockquote className="hero-stage-5 glass relative w-full max-w-3xl rounded-2xl px-6 py-5 text-center md:text-left">
              <span
                aria-hidden
                className="font-display pointer-events-none absolute -left-1 -top-3 select-none text-[70px] italic leading-none text-[color:var(--color-accent-deep)]/40"
              >
                &ldquo;
              </span>
              <p className="font-display text-lg italic leading-snug text-[color:var(--color-fg)]/90 md:text-xl">
                Here I am, brain the size of a planet, and they ask me to
                build a login page. Fine. Reading your codebase…
              </p>
              <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
                — marvin
              </div>
            </blockquote>
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-6 pb-8">
          <ChatInput
            onSend={handleSend}
            onCancel={cancel}
            busy={busy}
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
                    />
                  ) : (
                    <SourceControlPanel
                      cwd={cwd}
                      visible={leftColumnTab === "source-control"}
                      selectedPath={selectedPath ?? null}
                      onSelect={setSelectedPath}
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
            <PanelResizeHandle className="hidden w-px bg-[color:var(--color-border)] transition hover:w-[3px] hover:bg-[color:var(--color-accent-deep)]/40 lg:block" />
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
                <div className="flex h-full min-h-0 flex-col">
                  <div className="px-4 pt-3">
                    <StatusBar
                      state={marvinState}
                      stats={stats}
                      marvinSessionId={marvinSessionId}
                    />
                  </div>
                  <div
                    ref={scrollerRef}
                    className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4"
                  >
                    <div className="flex flex-col gap-4">
                      {messages.map((m) => (
                        <MessageView
                          key={m.id}
                          message={m}
                          onDecideConfirm={decideConfirm}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="px-4 pb-4">
                    <ChatInput
                      onSend={handleSend}
                      onCancel={cancel}
                      busy={busy}
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
    </main>
  );
}

// A2 decomposition: `LabeledGroup`, `PaneToggle`, `Capability`,
// `ExamplePrompt`, and `labelFor` moved to
// apps/web/src/components/shell/page-helpers.tsx. Pure JSX + props
// with no state/effects — safe to extract without behaviour change.
