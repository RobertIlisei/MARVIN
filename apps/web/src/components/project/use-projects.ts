"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { ProjectRecord, ProjectsResponse, VerifyResult } from "./types";

const LS_ACTIVE_KEY = "marvin.activeProject";

export interface UseProjectsApi {
  projects: ProjectRecord[];
  active: ProjectRecord | null;
  activeId: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addProject: (input: { name?: string; workDir: string; setActive?: boolean }) => Promise<
    | { ok: true; project: ProjectRecord }
    | { ok: false; error: string; verify?: VerifyResult }
  >;
  removeProject: (id: string) => Promise<boolean>;
  selectProject: (id: string | null) => Promise<void>;
  verifyWorkDir: (path: string) => Promise<VerifyResult>;
}

export function useProjects(): UseProjectsApi {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ProjectsResponse;
      setProjects(data.projects);
      // Prefer server-side active; fall back to localStorage last-seen.
      let next = data.active;
      if (!next) {
        try {
          next = localStorage.getItem(LS_ACTIVE_KEY);
        } catch {
          /* no storage */
        }
      }
      if (next && !data.projects.some((p) => p.id === next)) next = null;
      setActiveId(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const active = useMemo(
    () => projects.find((p) => p.id === activeId) ?? null,
    [projects, activeId],
  );

  const addProject = useCallback<UseProjectsApi["addProject"]>(
    async (input) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
          verify?: VerifyResult;
        };
        return {
          ok: false,
          error: payload.error ?? `HTTP ${res.status}`,
          ...(payload.verify ? { verify: payload.verify } : {}),
        };
      }
      const data = (await res.json()) as { project: ProjectRecord };
      await refresh();
      if (input.setActive) {
        try {
          localStorage.setItem(LS_ACTIVE_KEY, data.project.id);
        } catch {
          /* no storage */
        }
        setActiveId(data.project.id);
      }
      return { ok: true, project: data.project };
    },
    [refresh],
  );

  const removeProject = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/projects?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) return false;
      if (activeId === id) {
        setActiveId(null);
        try {
          localStorage.removeItem(LS_ACTIVE_KEY);
        } catch {
          /* no storage */
        }
      }
      await refresh();
      return true;
    },
    [activeId, refresh],
  );

  const selectProject = useCallback(async (id: string | null) => {
    setActiveId(id);
    try {
      if (id) localStorage.setItem(LS_ACTIVE_KEY, id);
      else localStorage.removeItem(LS_ACTIVE_KEY);
    } catch {
      /* no storage */
    }
    try {
      await fetch("/api/projects/active", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      /* best-effort */
    }
  }, []);

  const verifyWorkDir = useCallback(async (path: string) => {
    const res = await fetch(
      `/api/projects/verify?path=${encodeURIComponent(path)}`,
      { cache: "no-store" },
    );
    if (!res.ok) {
      return {
        ok: false,
        absolutePath: path,
        exists: false,
        isDirectory: false,
        readable: false,
        error: `HTTP ${res.status}`,
      } satisfies VerifyResult;
    }
    return (await res.json()) as VerifyResult;
  }, []);

  return {
    projects,
    active,
    activeId,
    loading,
    error,
    refresh,
    addProject,
    removeProject,
    selectProject,
    verifyWorkDir,
  };
}
