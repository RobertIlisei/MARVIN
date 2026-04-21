"use client";

/**
 * MARVIN's Honeycomb-config dialog. Surfaces the per-project config
 * stored at `<workDir>/.marvin/honeycomb.json` (see
 * `packages/runtime/src/honeycomb-config.ts`) — the UI analogue of
 * editing that JSON file by hand.
 *
 * Security:
 *   - Raw apiKey only travels in a single POST. Subsequent GETs
 *     return a masked `hcbik_…abcd` form.
 *   - The "Test connection" button hits `/api/honeycomb/test`, which
 *     calls Honeycomb's `/1/auth` endpoint server-side so the apiKey
 *     never leaves the Node process. The UI only sees the team
 *     metadata Honeycomb returns.
 */

import { Button } from "@marvin/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvin/ui/dialog";
import { Input } from "@marvin/ui/input";
import { useCallback, useEffect, useMemo, useState } from "react";

type Source = "env" | "workdir" | "global" | "none";

interface ConfigStatus {
  configured: boolean;
  source: Source;
  apiKeyMasked: string | null;
  environment: string | null;
  dataset: string | null;
  apiUrl: string;
  path: string | null;
}

interface TestResult {
  ok: boolean;
  team?: { name?: string | null; slug?: string | null } | null;
  environment?: {
    name?: string | null;
    slug?: string | null;
    matchesConfigured?: boolean;
  } | null;
  error?: string;
  hint?: string;
}

const DEFAULT_API_URL = "https://api.honeycomb.io";

export function HoneycombConfigDialog({
  cwd,
  open,
  onOpenChange,
  onSaved,
}: {
  cwd: string | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved?(status: ConfigStatus): void;
}) {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [environment, setEnvironment] = useState("");
  const [dataset, setDataset] = useState("");
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      return;
    }
    setLoadingStatus(true);
    try {
      const res = await fetch(
        `/api/honeycomb/config?cwd=${encodeURIComponent(cwd)}`,
      );
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as ConfigStatus;
      setStatus(body);
      if (body.configured) {
        setEnvironment(body.environment ?? "");
        setDataset(body.dataset ?? "");
        setApiUrl(body.apiUrl || DEFAULT_API_URL);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingStatus(false);
    }
  }, [cwd]);

  useEffect(() => {
    if (open) {
      setError(null);
      setTestResult(null);
      setApiKey(""); // never prefill; always a fresh paste
      void refreshStatus();
    }
  }, [open, refreshStatus]);

  const canSave = useMemo(
    () => !!cwd && apiKey.trim().length > 0 && environment.trim().length > 0,
    [cwd, apiKey, environment],
  );

  const save = useCallback(async () => {
    if (!cwd || !canSave) return;
    setSaving(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch("/api/honeycomb/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          apiKey: apiKey.trim(),
          environment: environment.trim(),
          dataset: dataset.trim() || undefined,
          apiUrl: apiUrl.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        detail?: string | null;
        status?: ConfigStatus;
      };
      if (!res.ok || !body.ok) {
        setError(body.detail ?? body.error ?? `save failed (${res.status})`);
        return;
      }
      setApiKey(""); // scrub immediately after save
      if (body.status) {
        setStatus(body.status);
        onSaved?.(body.status);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [cwd, canSave, apiKey, environment, dataset, apiUrl, onSaved]);

  const remove = useCallback(async () => {
    if (!cwd) return;
    setDeleting(true);
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch(
        `/api/honeycomb/config?cwd=${encodeURIComponent(cwd)}`,
        { method: "DELETE" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        removed?: boolean;
        status?: ConfigStatus;
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `delete failed (${res.status})`);
        return;
      }
      if (body.status) {
        setStatus(body.status);
        onSaved?.(body.status);
      }
      setApiKey("");
      setEnvironment("");
      setDataset("");
      setApiUrl(DEFAULT_API_URL);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }, [cwd, onSaved]);

  const test = useCallback(async () => {
    if (!cwd) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch("/api/honeycomb/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const body = (await res.json().catch(() => ({}))) as TestResult;
      setTestResult({ ...body, ok: res.ok && body.ok === true });
    } catch (e) {
      setTestResult({
        ok: false,
        error: "network-error",
        hint: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }, [cwd]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Honeycomb observability</DialogTitle>
          <DialogDescription>
            MARVIN's <code>marvin-honeycomb</code> MCP server uses this config
            to query traces + datasets. Stored at <code>&lt;project&gt;/.marvin/honeycomb.json</code> with 600 permissions.
          </DialogDescription>
        </DialogHeader>

        {!cwd && (
          <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/50 px-3 py-2 font-mono text-[11px] text-[color:var(--color-fg-dim)]">
            Pick a project first — the Honeycomb config is per-project (see ADR-0005).
          </div>
        )}

        <div className="flex flex-col gap-3 font-mono text-[11px]">
          <StatusRow status={status} loading={loadingStatus} />

          <div className="flex flex-col gap-1">
            <label
              htmlFor="honeycomb-api-key"
              className="text-[color:var(--color-fg-faint)] uppercase tracking-[0.22em] text-[10px]"
            >
              api key
            </label>
            <Input
              id="honeycomb-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                status?.configured
                  ? `configured — ${status.apiKeyMasked ?? "hidden"} (paste to replace)`
                  : "hcbik_…"
              }
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
              disabled={!cwd}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label
                htmlFor="honeycomb-env"
                className="text-[color:var(--color-fg-faint)] uppercase tracking-[0.22em] text-[10px]"
              >
                environment
              </label>
              <Input
                id="honeycomb-env"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                placeholder="prod"
                className="font-mono"
                spellCheck={false}
                disabled={!cwd}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="honeycomb-dataset"
                className="text-[color:var(--color-fg-faint)] uppercase tracking-[0.22em] text-[10px]"
              >
                dataset <span className="normal-case">(optional)</span>
              </label>
              <Input
                id="honeycomb-dataset"
                value={dataset}
                onChange={(e) => setDataset(e.target.value)}
                placeholder="my-service"
                className="font-mono"
                spellCheck={false}
                disabled={!cwd}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="self-start text-[10px] uppercase tracking-[0.22em] text-[color:var(--color-fg-faint)] transition hover:text-[color:var(--color-fg)]"
          >
            {showAdvanced ? "hide advanced" : "advanced"}
          </button>
          {showAdvanced && (
            <div className="flex flex-col gap-1">
              <label
                htmlFor="honeycomb-url"
                className="text-[color:var(--color-fg-faint)] uppercase tracking-[0.22em] text-[10px]"
              >
                api url
              </label>
              <Input
                id="honeycomb-url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder={DEFAULT_API_URL}
                className="font-mono"
                spellCheck={false}
                disabled={!cwd}
              />
              <span className="text-[10px] text-[color:var(--color-fg-faint)]">
                Use <code>https://api.eu1.honeycomb.io</code> for EU tenants.
                Must be <code>https://*.honeycomb.io</code>.
              </span>
            </div>
          )}

          {testResult && (
            <div
              className={`rounded-md border px-3 py-2 text-[11px] ${
                testResult.ok
                  ? "border-[color:var(--color-success)]/40 bg-[color:var(--color-success)]/10 text-[color:var(--color-success)]"
                  : "border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10 text-[color:var(--color-danger)]"
              }`}
            >
              {testResult.ok ? (
                <div className="space-y-0.5">
                  <div>
                    connected ✓ team{" "}
                    <span className="text-[color:var(--color-fg)]">
                      {testResult.team?.slug ?? "—"}
                    </span>
                    {testResult.team?.name &&
                      testResult.team.name !== testResult.team.slug && (
                        <span className="text-[color:var(--color-fg-dim)]">
                          {" "}
                          ({testResult.team.name})
                        </span>
                      )}
                  </div>
                  <div>
                    environment{" "}
                    <span className="text-[color:var(--color-fg)]">
                      {testResult.environment?.name ?? "—"}
                    </span>
                    {testResult.environment?.matchesConfigured === false && (
                      <span className="text-[color:var(--color-warn)]">
                        {" "}
                        — differs from configured "{environment}"
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div>
                  <div>test failed: {testResult.error ?? "unknown"}</div>
                  {testResult.hint && (
                    <div className="mt-0.5 text-[10px] opacity-80">
                      {testResult.hint}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-[color:var(--color-danger)]/40 bg-[color:var(--color-danger)]/10 px-3 py-2 text-[11px] text-[color:var(--color-danger)]">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            onClick={remove}
            disabled={!cwd || !status?.configured || deleting}
            className="text-[color:var(--color-fg-dim)]"
          >
            {deleting ? "removing…" : "Remove"}
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={test}
              disabled={!cwd || !status?.configured || testing}
            >
              {testing ? "testing…" : "Test connection"}
            </Button>
            <Button onClick={save} disabled={!canSave || saving}>
              {saving ? "saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusRow({
  status,
  loading,
}: {
  status: ConfigStatus | null;
  loading: boolean;
}) {
  if (loading && !status) {
    return (
      <div className="text-[color:var(--color-fg-dim)]">reading config…</div>
    );
  }
  if (!status) return null;
  if (!status.configured) {
    return (
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/50 px-3 py-2 text-[color:var(--color-fg-dim)]">
        no Honeycomb config yet — fill in below and save.
      </div>
    );
  }
  const sourceLabel =
    status.source === "env"
      ? "env vars (HONEYCOMB_API_KEY)"
      : status.source === "workdir"
        ? "this project"
        : status.source === "global"
          ? "user-global ~/.marvin/honeycomb.json"
          : "—";
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)]/50 px-3 py-2 text-[color:var(--color-fg)]">
      <div>
        configured ✓ source{" "}
        <span className="text-[color:var(--color-fg-dim)]">{sourceLabel}</span>
      </div>
      <div className="text-[color:var(--color-fg-dim)]">
        key <span className="text-[color:var(--color-fg)]">{status.apiKeyMasked}</span>
        {" · "}env <span className="text-[color:var(--color-fg)]">{status.environment}</span>
        {status.dataset && (
          <>
            {" · "}dataset{" "}
            <span className="text-[color:var(--color-fg)]">{status.dataset}</span>
          </>
        )}
      </div>
    </div>
  );
}
