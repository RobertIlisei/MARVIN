"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { MarvinBrain } from "@/components/brain/marvin-brain";
import { MessageView } from "@/components/chat/message-view";
import { useChatStream } from "@/components/chat/use-chat-stream";
import { CostPill } from "@/components/cost/cost-pill";
import { FileTree } from "@/components/file-tree/file-tree";
import { FileViewer } from "@/components/file-viewer/file-viewer";
import { GraphPanel } from "@/components/graph/graph-panel";
import { ChatInput } from "@/components/input/chat-input";
import { PreviewPane } from "@/components/preview/preview-pane";
import { BranchBadge } from "@/components/project/branch-badge";
import { ProjectPicker } from "@/components/project/project-picker";
import { useProjects } from "@/components/project/use-projects";
import {
  PersonalityToggle,
  type PersonalityMode,
} from "@/components/settings/personality-toggle";
import { ModelPicker } from "@/components/settings/model-picker";
import { ThemeToggle } from "@/components/settings/theme-toggle";
import {
  PermissionToggle,
  type PermissionStrategy,
} from "@/components/settings/permission-toggle";
import { ShortcutsHelp } from "@/components/settings/shortcuts-help";
import { StatusBar } from "@/components/shell/status-bar";
import { Terminal } from "@/components/terminal/terminal";

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
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
        if (shortcutsOpen) setShortcutsOpen(false);
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
      // Cmd+P — toggle preview
      if (e.key === "p" && !e.shiftKey) {
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
  }, [shortcutsOpen, reset, togglePane, cancel]);

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

  // --- Header ------------------------------------------------------------
  const header = (
    <>
    <header className="flex items-center gap-3 px-5 py-2.5">
      <span className="font-display text-[22px] italic leading-none text-[color:var(--color-fg)]">
        marvin
      </span>
      <span className="hidden text-[10px] uppercase tracking-[0.28em] text-[color:var(--color-fg-faint)] md:inline">
        v0.0.1 · phase 5
      </span>
      <div className="mx-3 h-5 w-px bg-[color:var(--color-border)]" />
      <ProjectPicker
        projects={projects}
        active={active}
        loading={projectsLoading}
        onSelect={selectProject}
        onRemove={removeProject}
        onAdd={addProject}
        verifyWorkDir={verifyWorkDir}
        onResumeSession={handleResumeSession}
        openSignal={pickerOpenSignal}
      />
      <BranchBadge
        cwd={active?.workDir ?? null}
        refreshKey={sessionRefreshKey}
      />
      <div className="ml-auto flex items-center gap-3">
        <CostPill projectId={active?.id ?? null} refreshKey={sessionRefreshKey} />
        <LabeledGroup label="perms">
          <PermissionToggle
            value={permissionStrategy}
            onChange={setPermissionStrategy}
          />
        </LabeledGroup>
        <LabeledGroup label="models">
          <ModelPicker
            executor={executorModel}
            advisor={advisorModel}
            onChange={({ executor, advisor }) => {
              setExecutorModel(executor);
              setAdvisorModel(advisor);
            }}
          />
        </LabeledGroup>
        <LabeledGroup label="voice">
          <PersonalityToggle value={personality} onChange={setPersonality} />
        </LabeledGroup>
        <LabeledGroup label="theme">
          <ThemeToggle />
        </LabeledGroup>
        <LabeledGroup label="panes">
          <PaneToggle
            label="files"
            active={panes.files}
            onClick={() => togglePane("files")}
            kbd="⌘B"
            tip="project file tree"
          />
          <PaneToggle
            label="graph"
            active={panes.graph}
            onClick={() => togglePane("graph")}
            kbd="⌘G"
            tip="knowledge graph of the codebase"
          />
          <PaneToggle
            label="brain"
            active={panes.brain}
            onClick={() => togglePane("brain")}
            tip="live MARVIN brain visualization"
          />
          <PaneToggle
            label="preview"
            active={panes.preview}
            onClick={() => togglePane("preview")}
            disabled={!cwd}
            kbd="⌘P"
            tip="live web preview of dev server"
          />
          <PaneToggle
            label="term"
            active={panes.terminal}
            onClick={() => togglePane("terminal")}
            disabled={!cwd}
            kbd="⌘J"
            tip="embedded terminal in the project cwd"
          />
        </LabeledGroup>
        <button
          type="button"
          onClick={reset}
          disabled={isEmpty}
          title="start a new MARVIN session (⌘⇧N)"
          className="rounded-md border border-[color:var(--color-border)] px-2.5 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          new session
        </button>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          title="keyboard shortcuts (?)"
          className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
        >
          ?
        </button>
      </div>
    </header>
    <div className="status-rail" aria-hidden />
    </>
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
        {header}
        <div className="scroll-thin relative flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-6 py-6">
          <div className="flex w-full max-w-5xl flex-col items-center gap-6 pt-4">
            <div className="grid w-full grid-cols-1 items-center gap-10 md:grid-cols-[auto_1fr]">
              <div className="hero-orbit hero-brain-intro relative flex h-[420px] w-[420px] items-center justify-center md:h-[460px] md:w-[460px]">
                <MarvinBrain state={marvinState} size={340} />
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

  const centerNeedsVerticalSplit = Boolean(
    (selectedPath && cwd) || (panes.terminal && cwd) || (panes.preview && cwd),
  );

  const showFiles = panes.files && !!cwd;
  const showBrain = panes.brain;
  const showGraph = panes.graph && !!cwd;
  const showPreview = panes.preview && !!cwd;

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden">
      {header}
      <PanelGroup
        direction="horizontal"
        autoSaveId="marvin-shell-h-v2"
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
              <aside className="flex h-full flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/30">
                <div className="flex items-center justify-between border-b border-[color:var(--color-border)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-fg-faint)]">
                  <span>files</span>
                </div>
                <div className="min-h-0 flex-1">
                  <FileTree
                    cwd={cwd}
                    onSelect={setSelectedPath}
                    {...(selectedPath ? { selectedPath } : {})}
                  />
                </div>
              </aside>
            </Panel>
            <PanelResizeHandle className="hidden w-px bg-[color:var(--color-border)] transition hover:w-[3px] hover:bg-[color:var(--color-accent-deep)]/40 lg:block" />
          </>
        )}

        <Panel id="center" order={2} defaultSize={60} minSize={40}>
          <section className="flex h-full min-w-0 flex-col">
            <div className="px-6 pt-3">
              <StatusBar
                state={marvinState}
                stats={stats}
                marvinSessionId={marvinSessionId}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              {centerNeedsVerticalSplit ? (
                <PanelGroup
                  direction="vertical"
                  autoSaveId="marvin-center-v-v2"
                  className="flex-1"
                >
                  <Panel id="chat" order={1} defaultSize={58} minSize={25}>
                    <div
                      ref={scrollerRef}
                      className="scroll-thin h-full overflow-y-auto px-6 py-6"
                    >
                      <div className="mx-auto flex max-w-4xl flex-col gap-4">
                        {messages.map((m) => (
                          <MessageView
                            key={m.id}
                            message={m}
                            onDecideConfirm={decideConfirm}
                          />
                        ))}
                      </div>
                    </div>
                  </Panel>
                  {selectedPath && cwd && (
                    <>
                      <PanelResizeHandle className="h-px bg-[color:var(--color-border)] transition hover:h-[3px] hover:bg-[color:var(--color-accent-deep)]/40" />
                      <Panel
                        id="file-viewer"
                        order={2}
                        defaultSize={30}
                        minSize={15}
                      >
                        <FileViewer
                          cwd={cwd}
                          filePath={selectedPath}
                          onClose={() => setSelectedPath(undefined)}
                        />
                      </Panel>
                    </>
                  )}
                  {showPreview && (
                    <>
                      <PanelResizeHandle className="h-px bg-[color:var(--color-border)] transition hover:h-[3px] hover:bg-[color:var(--color-accent-deep)]/40" />
                      <Panel
                        id="preview"
                        order={3}
                        defaultSize={30}
                        minSize={15}
                      >
                        <PreviewPane projectId={active?.id ?? null} />
                      </Panel>
                    </>
                  )}
                  {panes.terminal && cwd && (
                    <>
                      <PanelResizeHandle className="h-px bg-[color:var(--color-border)] transition hover:h-[3px] hover:bg-[color:var(--color-accent-deep)]/40" />
                      <Panel
                        id="terminal"
                        order={4}
                        defaultSize={30}
                        minSize={15}
                      >
                        <Terminal cwd={cwd} />
                      </Panel>
                    </>
                  )}
                </PanelGroup>
              ) : (
                <div
                  ref={scrollerRef}
                  className="scroll-thin h-full flex-1 overflow-y-auto px-6 py-6"
                >
                  <div className="mx-auto flex max-w-4xl flex-col gap-4">
                    {messages.map((m) => (
                      <MessageView
                        key={m.id}
                        message={m}
                        onDecideConfirm={decideConfirm}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="mx-auto w-full max-w-4xl px-6 pb-6">
              <ChatInput
                onSend={handleSend}
                onCancel={cancel}
                busy={busy}
                disabled={!cwd}
                hint={hint}
              />
            </div>
          </section>
        </Panel>

        {(showGraph || showBrain) && (
          <>
            <PanelResizeHandle className="hidden w-px bg-[color:var(--color-border)] transition hover:w-[3px] hover:bg-[color:var(--color-accent-deep)]/40 md:block" />
            <Panel
              id="side"
              order={3}
              defaultSize={22}
              minSize={16}
              maxSize={36}
              className="hidden md:block"
            >
              {showGraph ? (
                <aside className="h-full bg-[color:var(--color-bg-elev)]/20">
                  <GraphPanel cwd={cwd} />
                </aside>
              ) : (
                <aside className="flex h-full min-h-0 flex-col bg-gradient-to-b from-transparent via-[color:var(--color-bg-elev)]/30 to-transparent px-6 py-8">
                  <div className="flex flex-col items-center gap-4">
                    <MarvinBrain state={marvinState} size={260} />
                    <div className="text-center">
                      <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-[color:var(--color-fg-faint)]">
                        state
                      </div>
                      <div className="mt-1 font-mono text-sm text-[color:var(--color-accent)]">
                        {labelFor(marvinState)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-auto space-y-3 font-mono text-[11px] text-[color:var(--color-fg-dim)]">
                    <div>
                      <span className="text-[color:var(--color-fg-faint)]">project</span>
                      <div className="mt-1 truncate text-[color:var(--color-fg)]/85">
                        {active?.name ?? "—"}
                      </div>
                      {active && (
                        <div className="mt-0.5 truncate text-[10px] text-[color:var(--color-fg-faint)]">
                          {active.workDir}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center justify-between border-t border-[color:var(--color-border)] pt-3">
                      <span className="text-[color:var(--color-fg-faint)]">model</span>
                      <span className="text-[color:var(--color-fg)]/85">claude-opus-4-7</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[color:var(--color-fg-faint)]">v</span>
                      <span className="text-[color:var(--color-fg)]/85">0.0.1 · phase 5</span>
                    </div>
                  </div>
                </aside>
              )}
            </Panel>
          </>
        )}
      </PanelGroup>
      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </main>
  );
}

function LabeledGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="hidden font-mono text-[9px] uppercase tracking-[0.26em] text-[color:var(--color-fg-faint)] xl:inline">
        {label}
      </span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

function PaneToggle({
  label,
  active,
  onClick,
  disabled,
  kbd,
  tip,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Optional keyboard hint shown in the tooltip. */
  kbd?: string;
  /** Descriptive tooltip explaining what the pane does. */
  tip?: string;
}) {
  const title = [tip ?? label, kbd ? `(${kbd})` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition disabled:cursor-not-allowed disabled:opacity-30 ${
        active
          ? "border-[color:var(--color-accent-deep)]/40 bg-[color:var(--color-accent-glow)] text-[color:var(--color-accent)]"
          : "border-[color:var(--color-border)] text-[color:var(--color-fg-dim)] hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
      }`}
    >
      {label}
    </button>
  );
}

function Capability({ label, hint }: { label: string; hint: string }) {
  return (
    <div
      title={hint}
      className="glass rounded-lg px-3 py-2 text-left"
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-accent)]">
        {label}
      </div>
      <div className="mt-0.5 text-[11px] leading-snug text-[color:var(--color-fg-dim)]">
        {hint}
      </div>
    </div>
  );
}

function ExamplePrompt({
  title,
  body,
  onUse,
  disabled,
}: {
  title: string;
  body: string;
  onUse: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onUse(body)}
      disabled={disabled}
      title={disabled ? "pick a project first" : `use this prompt`}
      className="group glass rounded-xl px-4 py-3 text-left transition enabled:hover:border-[color:var(--color-accent-deep)]/40 enabled:hover:bg-[color:var(--color-accent-glow)]/10 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[color:var(--color-accent)]">
          {title}
        </div>
        <span className="font-mono text-[10px] text-[color:var(--color-fg-faint)] transition group-enabled:group-hover:text-[color:var(--color-accent)]">
          ↩ try
        </span>
      </div>
      <div className="mt-1.5 text-[12px] leading-relaxed text-[color:var(--color-fg)]/90">
        {body}
      </div>
    </button>
  );
}

function labelFor(state: string): string {
  return (
    {
      idle: "standing by",
      thinking: "thinking",
      tool: "running a tool",
      writing: "writing",
      error: "something broke",
    }[state] ?? state
  );
}
