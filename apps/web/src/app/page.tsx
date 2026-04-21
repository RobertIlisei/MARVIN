"use client";

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { AdvisorOrb } from "@/components/brain/advisor-orb";
import { BrainLiquid } from "@/components/brain/brain-liquid";
import { MessageView } from "@/components/chat/message-view";
import { useChatStream } from "@/components/chat/use-chat-stream";
import { CostPill } from "@/components/cost/cost-pill";
import { FileTree } from "@/components/file-tree/file-tree";
import { QuickOpen } from "@/components/file-tree/quick-open";
import { FileViewer } from "@/components/file-viewer/file-viewer";
import { GraphPanel } from "@/components/graph/graph-panel";
import { ChatInput } from "@/components/input/chat-input";
import {
  LeftColumnTabs,
  useLeftColumnTab,
} from "@/components/left-column-tabs";
import { PreviewPane } from "@/components/preview/preview-pane";
import { BranchBadge } from "@/components/project/branch-badge";
import { ProjectPicker } from "@/components/project/project-picker";
import { useProjects } from "@/components/project/use-projects";
import { ModelPicker } from "@/components/settings/model-picker";
import {
  type PermissionStrategy,
  PermissionToggle,
} from "@/components/settings/permission-toggle";
import {
  type PersonalityMode,
  PersonalityToggle,
} from "@/components/settings/personality-toggle";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { ShortcutsHelp } from "@/components/settings/shortcuts-help";
import { ThemeToggle } from "@/components/settings/theme-toggle";
import { StatusBar } from "@/components/shell/status-bar";
import { useTauriMenu } from "@/components/shell/use-tauri-menu";
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

  // Native menu-bar wiring for the Tauri desktop build. No-op in a
  // browser tab. Keep IDs in sync with `src-tauri/src/lib.rs`'s
  // `ids` module.
  useTauriMenu({
    newSession: reset,
    quickOpen: () => cwd && setQuickOpenOpen(true),
    openProjectPicker: () => setPickerOpenSignal((v) => v + 1),
    cancelTurn: cancel,
    toggleShortcutsHelp: () => setShortcutsOpen((v) => !v),
    togglePane: (key) => togglePane(key as keyof PaneState),
    openUrl: (url) => {
      if (typeof window !== "undefined") {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    },
  });

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
  const header = (
    <>
    <header
      // Dragging the window by the header chrome only works inside the
      // Tauri `.app`. `data-tauri-drag-region` tells the webview "this
      // region is the window title bar for drag purposes" — needed
      // because tauri.conf.json sets `titleBarStyle: "Overlay"` which
      // hides the native bar and overlays the traffic lights on top
      // of our content. In a normal browser tab the attribute is an
      // unknown data-* and has no effect.
      //
      // Interactive elements inside the header (buttons, inputs) stop
      // the drag because Tauri treats any click on a clickable
      // descendant as a regular click, not a drag. That's the
      // intended behaviour.
      data-tauri-drag-region
      // Left padding clears the macOS traffic-light cluster (Tauri
      // renders them at ~12px from the left edge; 3 buttons + gaps is
      // ~72px). `pl-[82px]` leaves a comfortable gutter. In a normal
      // browser tab the traffic lights don't exist and the extra
      // padding simply centers branding a bit further in — acceptable
      // trade-off since the Tauri build is the primary UI.
      className="flex flex-wrap items-center gap-x-3 gap-y-2 pl-[82px] pr-5 py-2.5"
    >
      <button
        type="button"
        onClick={isEmpty ? undefined : reset}
        disabled={isEmpty}
        aria-label={isEmpty ? "marvin" : "return to home — start a new session"}
        title={isEmpty ? undefined : "return to home · ⌘⇧N"}
        className="font-display text-[22px] italic leading-none text-[color:var(--color-fg)] outline-none transition hover:opacity-80 disabled:cursor-default disabled:opacity-100"
      >
        marvin
      </button>
      <span className="hidden text-[10px] uppercase tracking-[0.28em] text-[color:var(--color-fg-faint)] md:inline">
        v1
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
      <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        <CostPill projectId={active?.id ?? null} refreshKey={sessionRefreshKey} />
        {/* perms / models / voice only show on wide viewports — they're
         * also accessible via the ⚙ Settings panel, so we collapse them
         * instead of letting them clip on medium screens. Theme flip
         * stays visible since users hit it mid-session more than the
         * others. `panes` toggles stay too (quick-flip essentials). */}
        <LabeledGroup label="perms" className="hidden xl:inline-flex">
          <PermissionToggle
            value={permissionStrategy}
            onChange={setPermissionStrategy}
          />
        </LabeledGroup>
        <LabeledGroup label="models" className="hidden xl:inline-flex">
          <ModelPicker
            executor={executorModel}
            advisor={advisorModel}
            onChange={({ executor, advisor }) => {
              setExecutorModel(executor);
              setAdvisorModel(advisor);
            }}
          />
        </LabeledGroup>
        <LabeledGroup label="voice" className="hidden 2xl:inline-flex">
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
          onClick={() => openSettings()}
          title="Settings — models, observability, appearance, permissions"
          aria-label="open settings"
          className="rounded-md border border-[color:var(--color-border)] px-2 py-1 font-mono text-[11px] text-[color:var(--color-fg-dim)] transition hover:border-[color:var(--color-border-strong)] hover:text-[color:var(--color-fg)]"
        >
          ⚙
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
      {header}
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
              <aside className="flex h-full flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/30">
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
          <aside className="flex h-full min-h-0 flex-col border-l border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/20">
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

function LabeledGroup({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  /** Extra responsive classes from the caller (e.g. `hidden xl:inline-flex`). */
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`.trim()}>
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
