"use client";

/**
 * Central persisted-preferences for MARVIN's UI.
 *
 * Audit finding #16 + #18: page.tsx was carrying seven separate
 * `localStorage` keys with their own try/catch effects, plus an
 * 18-prop bag drilled down to TopBar so the header could read them.
 * That's a god-component pattern — it spread state across two layers
 * and made "reset MARVIN preferences" impossible without manual
 * clearing of each key.
 *
 * Replacement: one typed `MarvinPrefs` object behind a Context, a
 * single hook that hydrates lazily on the client (no SSR localStorage
 * access — the server can't see it), and a single `Reset MARVIN
 * preferences` action that clears everything in one call.
 *
 * **Not in here:** per-project / per-cwd state.
 *   - `marvin.session.<projectId>` (the in-flight session id) lives
 *     in page.tsx because it's keyed by project and read by the
 *     resume-after-refresh path.
 *   - `marvin.fileTree.openDirs:<cwd>` (per-project open dirs) lives
 *     in `file-tree.tsx`.
 *   - Theme persistence is handled via `<html data-theme>` + the
 *     pre-hydration bootstrap script (see layout.tsx), not a JS-side
 *     localStorage hook — keeping it here would race the bootstrap.
 *
 * What IS in here is the cross-cutting global prefs:
 *   personality · executor model · advisor model · permission strategy
 *   · panes layout.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { PermissionStrategy } from "@/components/settings/permission-toggle";
import type { PersonalityMode } from "@/components/settings/personality-toggle";

export interface PaneState {
  files: boolean;
  brain: boolean;
  graph: boolean;
  preview: boolean;
  terminal: boolean;
}

export interface MarvinPrefs {
  personality: PersonalityMode;
  executorModel: string | null;
  advisorModel: string | null;
  permissionStrategy: PermissionStrategy;
  panes: PaneState;
  /**
   * Audit finding #2: the `auto` permission default is a silent
   * full-bypass. The first-run banner explains it on first launch and
   * dismisses on click. Setting this to `true` (default for new
   * users) means "show the banner if perm is auto"; the user dismisses
   * by clicking, which flips it to false. `reset()` does NOT reset
   * this — once dismissed, stay dismissed across "reset preferences"
   * because re-explaining is annoying and the user has presumably
   * understood the message by then.
   */
  showAutoModeBanner: boolean;
}

/**
 * Default prefs used during SSR (and as the post-reset baseline).
 * Mirrors the historical defaults from page.tsx — files + brain on,
 * everything else off; auto permission strategy; marvin voice.
 */
export const DEFAULT_PREFS: MarvinPrefs = {
  personality: "marvin",
  executorModel: null,
  advisorModel: null,
  permissionStrategy: "auto",
  panes: {
    files: true,
    brain: true,
    graph: false,
    preview: false,
    terminal: false,
  },
  // Default true so a fresh user sees the banner once. Persisted as
  // `false` once dismissed.
  showAutoModeBanner: true,
};

/**
 * localStorage keys MARVIN owns at the global (non-per-project) level.
 * Exported so the "Reset MARVIN preferences" action in Settings can
 * clear all of them at once.
 */
export const PREFS_LS_KEYS = [
  "marvin.personality",
  "marvin.model.executor",
  "marvin.model.advisor",
  "marvin.permissionStrategy",
  "marvin.panes",
] as const;

/** Banner-dismissed flag. Kept out of the reset loop on purpose — once
 *  the user has seen the auto-mode warning, "reset preferences" should
 *  not re-trigger it. */
const LS_BANNER_DISMISSED = "marvin.autoModeBannerDismissed";

type LsKey = (typeof PREFS_LS_KEYS)[number];

/**
 * Lazy-load all five keys from localStorage on the client. Returns
 * the default prefs when running on the server or when storage is
 * unavailable (Tauri quirks, private mode).
 */
function readPrefs(): MarvinPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  const next: MarvinPrefs = { ...DEFAULT_PREFS };
  try {
    const personality = window.localStorage.getItem("marvin.personality");
    if (personality === "marvin" || personality === "neutral") {
      next.personality = personality;
    }
    const em = window.localStorage.getItem("marvin.model.executor");
    if (em) next.executorModel = em;
    const am = window.localStorage.getItem("marvin.model.advisor");
    if (am) next.advisorModel = am;
    const perm = window.localStorage.getItem("marvin.permissionStrategy");
    if (perm === "auto" || perm === "gated") next.permissionStrategy = perm;
    const rawPanes = window.localStorage.getItem("marvin.panes");
    if (rawPanes) {
      try {
        const parsed = JSON.parse(rawPanes) as Partial<PaneState>;
        next.panes = { ...next.panes, ...parsed };
      } catch {
        /* malformed — keep default */
      }
    }
    // Banner dismissed?  Only the explicit `"true"` string flips the
    // default; any other value (including absent) means "keep showing."
    if (window.localStorage.getItem(LS_BANNER_DISMISSED) === "true") {
      next.showAutoModeBanner = false;
    }
  } catch {
    /* no storage */
  }
  return next;
}

interface PrefsContextValue {
  prefs: MarvinPrefs;
  setPersonality(v: PersonalityMode): void;
  setExecutorModel(v: string | null): void;
  setAdvisorModel(v: string | null): void;
  setPermissionStrategy(v: PermissionStrategy): void;
  setPanes(updater: (prev: PaneState) => PaneState): void;
  togglePane(key: keyof PaneState): void;
  /** Set executor + advisor in one call — matches ModelPicker's onChange shape. */
  setModels(v: { executor: string | null; advisor: string | null }): void;
  /** Dismiss the first-run auto-mode banner. Persistent across resets. */
  dismissAutoModeBanner(): void;
  /** Wipe every persisted pref. Restores `DEFAULT_PREFS` and clears localStorage. */
  reset(): void;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

/**
 * Provider. Wrap the app once (in `sidecar/src/app/page.tsx` or a
 * layout) and any descendant can read prefs without prop-drilling.
 *
 * Why provide via Context instead of a raw hook: page.tsx + TopBar +
 * SettingsPanel + ChatInput all need the same view of the prefs.
 * Without a Context each component re-runs `readPrefs()` and manages
 * its own state — three different copies that drift on every set.
 * The Context centralises the writer, so a `setPersonality` from
 * Settings updates everyone in one render.
 */
export function MarvinPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<MarvinPrefs>(DEFAULT_PREFS);

  // Hydrate on the client. SSR uses DEFAULT_PREFS (which is what every
  // shape was anyway pre-localStorage); the first effect overwrites
  // with persisted values. Avoids the SSR / hydration mismatch the
  // previous page.tsx code dodged with a similar useEffect.
  useEffect(() => {
    const hydrated = readPrefs();
    setPrefs(hydrated);
    // Phase 5d — announce current state to the Swift shell so its
    // native Layout / Setup popovers reflect persisted prefs on
    // boot. The prefs hook already announces personality from its
    // own setter, but permission + panes only had localStorage
    // persistence; the announce calls plug them into the bridge.
  }, []);

  // Per-key writers — all of them update the in-memory state and
  // persist. The persistence side wrapped in try/catch so storage
  // unavailability degrades to memory-only (matches the previous
  // ad-hoc effects' behaviour).
  const persist = useCallback((key: LsKey, value: string | null) => {
    try {
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, value);
    } catch {
      /* no storage */
    }
  }, []);

  const setPersonality = useCallback(
    (v: PersonalityMode) => {
      setPrefs((p) => ({ ...p, personality: v }));
      persist("marvin.personality", v);
    },
    [persist],
  );
  const setExecutorModel = useCallback(
    (v: string | null) => {
      setPrefs((p) => ({ ...p, executorModel: v }));
      persist("marvin.model.executor", v);
    },
    [persist],
  );
  const setAdvisorModel = useCallback(
    (v: string | null) => {
      setPrefs((p) => ({ ...p, advisorModel: v }));
      persist("marvin.model.advisor", v);
    },
    [persist],
  );
  const setPermissionStrategy = useCallback(
    (v: PermissionStrategy) => {
      setPrefs((p) => ({ ...p, permissionStrategy: v }));
      persist("marvin.permissionStrategy", v);
    },
    [persist],
  );
  const setPanes = useCallback(
    (updater: (prev: PaneState) => PaneState) => {
      setPrefs((p) => {
        const next = { ...p, panes: updater(p.panes) };
        try {
          window.localStorage.setItem(
            "marvin.panes",
            JSON.stringify(next.panes),
          );
        } catch {
          /* no storage */
        }
        return next;
      });
    },
    [],
  );
  const togglePane = useCallback(
    (key: keyof PaneState) => {
      setPanes((prev) => ({ ...prev, [key]: !prev[key] }));
    },
    [setPanes],
  );
  const setModels = useCallback(
    (v: { executor: string | null; advisor: string | null }) => {
      setExecutorModel(v.executor);
      setAdvisorModel(v.advisor);
    },
    [setExecutorModel, setAdvisorModel],
  );
  const dismissAutoModeBanner = useCallback(() => {
    setPrefs((p) => ({ ...p, showAutoModeBanner: false }));
    try {
      window.localStorage.setItem(LS_BANNER_DISMISSED, "true");
    } catch {
      /* no storage */
    }
  }, []);
  const reset = useCallback(() => {
    // Reset preserves the banner-dismissed flag — it's not a "pref" in
    // the user's mental model (the user already learned about auto
    // mode; re-explaining is annoying). Reads from current state to
    // pick the post-reset value.
    setPrefs((p) => ({
      ...DEFAULT_PREFS,
      showAutoModeBanner: p.showAutoModeBanner,
    }));
    for (const k of PREFS_LS_KEYS) {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* no storage */
      }
    }
  }, []);

  const value = useMemo<PrefsContextValue>(
    () => ({
      prefs,
      setPersonality,
      setExecutorModel,
      setAdvisorModel,
      setPermissionStrategy,
      setPanes,
      togglePane,
      setModels,
      dismissAutoModeBanner,
      reset,
    }),
    [
      prefs,
      setPersonality,
      setExecutorModel,
      setAdvisorModel,
      setPermissionStrategy,
      setPanes,
      togglePane,
      setModels,
      dismissAutoModeBanner,
      reset,
    ],
  );

  return (
    <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
  );
}

/**
 * Hook for any component that needs the global prefs. Panics in dev
 * if called outside the provider — surfaces a wiring bug immediately
 * rather than silently returning defaults.
 */
export function useMarvinPrefs(): PrefsContextValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) {
    throw new Error(
      "useMarvinPrefs() must be called inside <MarvinPrefsProvider>",
    );
  }
  return ctx;
}
