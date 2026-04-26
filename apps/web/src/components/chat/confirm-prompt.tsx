"use client";

import { useState } from "react";

import { DiffViewer } from "@/components/diff/diff-viewer";

type EditInput = {
  file_path?: string;
  old_string?: string;
  new_string?: string;
};

type WriteInput = {
  file_path?: string;
  content?: string;
};

/**
 * Confirm prompt — the security-boundary card MARVIN renders when a
 * tool call needs the user's go-ahead. Previously rendered with the
 * same visual weight as a normal completed tool call (10 % opacity
 * accent, 1 px hairline border) — the audit (finding #11) found the
 * card faded into the chat panel for high-stakes operations like
 * `rm -rf`.
 *
 * This treatment leans on:
 *   - Severity classification (`warn` for routine, `danger` for
 *     patterns matching destructive Bash or secret-bearing paths).
 *   - 2 px coloured frame, filled allow button (the visual primary
 *     since allows are committal; deny is recoverable), brief 3-pulse
 *     animation on first render.
 *   - A blast-radius hint when we recognise a destructive pattern.
 *
 * Severity is a presentational decision only — actual policy lives
 * in `packages/tools/src/policy.ts`. If a Bash command matches
 * `BASH_HARD_DENY` it never reaches this component (the SDK denies
 * directly). What we see here is the auto-allow-list miss, where
 * the runtime asks the user. So it's worth grading by danger to the
 * filesystem, not by the policy class (which is always "confirm" by
 * the time we render).
 */
type Severity = "warn" | "danger";

const DESTRUCTIVE_BASH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\brm\s+-r[fF]?\b/, "removes files permanently — not recoverable from Trash"],
  [/\bgit\s+push\s+.*--force/, "rewrites remote git history — overwrites peers"],
  [/\bgit\s+reset\s+--hard\b/, "discards uncommitted local changes"],
  [/\bgit\s+clean\s+-[fdx]/, "deletes untracked files / dirs in this repo"],
  [/\bnpm\s+publish\b/, "publishes to npm — public, hard to retract"],
  [/\bcurl\s+.+\|\s*(sh|bash)\b/, "pipes a remote script straight to a shell"],
  [/\bdrop\s+(database|table|schema)\b/i, "drops a database object — irreversible"],
  [/\bchmod\s+-?R\s+777\b/, "world-writable on a tree — security hole"],
];

const SECRET_PATH_PATTERN = /(^|\/)(\.env(\.[^/]+)?|id_rsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx)$/i;

interface SeverityHint {
  severity: Severity;
  /** One-line blast-radius. Empty when nothing notable. */
  hint: string;
}

function classifySeverity(toolName: string, input: unknown): SeverityHint {
  const obj = (input ?? {}) as Record<string, unknown>;

  if (toolName === "Bash") {
    const cmd = String(obj.command ?? "");
    for (const [re, label] of DESTRUCTIVE_BASH_PATTERNS) {
      if (re.test(cmd)) return { severity: "danger", hint: label };
    }
    return { severity: "warn", hint: "" };
  }

  if (toolName === "Edit" || toolName === "Write") {
    const p = String(obj.file_path ?? obj.path ?? "");
    if (p && SECRET_PATH_PATTERN.test(p)) {
      return {
        severity: "danger",
        hint: "writes to a secret-bearing file (env / key / cert)",
      };
    }
    return { severity: "warn", hint: "" };
  }

  return { severity: "warn", hint: "" };
}

const SEVERITY_TINT: Record<Severity, string> = {
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
};

const SEVERITY_BG: Record<Severity, string> = {
  warn: "oklch(0.7 0.14 70 / 0.08)",
  danger: "oklch(0.6 0.18 25 / 0.08)",
};

export function ConfirmPrompt({
  toolName,
  input,
  reason,
  title,
  description,
  onAllow,
  onDeny,
  decided,
}: {
  toolName: string;
  input: unknown;
  reason: string;
  title?: string;
  description?: string;
  onAllow: () => Promise<void> | void;
  onDeny: (message?: string) => Promise<void> | void;
  decided?: "allow" | "deny";
}) {
  const [busy, setBusy] = useState(false);
  const [denyNote, setDenyNote] = useState("");
  const [showDeny, setShowDeny] = useState(false);

  const allow = async () => {
    setBusy(true);
    try {
      await onAllow();
    } finally {
      setBusy(false);
    }
  };
  const deny = async () => {
    setBusy(true);
    try {
      await onDeny(denyNote.trim() || undefined);
    } finally {
      setBusy(false);
    }
  };

  const editInput = toolName === "Edit" ? (input as EditInput) : null;
  const writeInput = toolName === "Write" ? (input as WriteInput) : null;
  const bashCommand =
    toolName === "Bash" && typeof input === "object" && input !== null
      ? String((input as { command?: unknown }).command ?? "")
      : null;

  const { severity, hint } = classifySeverity(toolName, input);
  const tint = SEVERITY_TINT[severity];
  const bg = SEVERITY_BG[severity];
  const headerLabel =
    severity === "danger"
      ? "MARVIN wants to run a destructive operation"
      : (title ?? `MARVIN wants to use ${toolName}`);

  return (
    <div
      className="rise-in confirm-pulse my-2 overflow-hidden rounded-lg text-xs"
      style={{
        // 2 px coloured frame (vs the previous 1 px accent-deep/40).
        // `--pulse-tint` is consumed by the .confirm-pulse keyframe.
        border: `2px solid ${tint}`,
        background: bg,
        ["--pulse-tint" as string]: tint,
      }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 font-mono"
        style={{
          background: tint,
          color: severity === "danger" ? "white" : "oklch(0.18 0.06 70)",
        }}
      >
        <span
          aria-hidden
          className="flex h-5 w-5 items-center justify-center rounded-md font-bold"
          style={{ background: "rgba(255,255,255,0.4)" }}
        >
          !
        </span>
        <span className="font-semibold text-[12px]">{headerLabel}</span>
        <span
          className="ml-auto rounded-full px-2 py-px text-[10px] uppercase tracking-widest"
          style={{ background: "rgba(0,0,0,0.18)" }}
        >
          awaiting confirm
        </span>
      </div>
      <div className="px-3 py-3 font-mono text-[11px] text-[color:var(--color-fg)]/90">
        {description && (
          <div className="mb-2 text-[color:var(--color-fg-dim)]">{description}</div>
        )}
        {reason && (
          <div className="mb-2 text-[color:var(--color-fg-faint)]">reason: {reason}</div>
        )}

        {editInput && (
          <>
            <div className="mb-1 text-[color:var(--color-fg-dim)]">
              {editInput.file_path ?? "file"}
            </div>
            <DiffViewer
              filePath={editInput.file_path ?? "untitled"}
              original={editInput.old_string ?? ""}
              modified={editInput.new_string ?? ""}
              maxHeight={320}
            />
          </>
        )}
        {writeInput && (
          <>
            <div className="mb-1 text-[color:var(--color-fg-dim)]">
              new file: {writeInput.file_path ?? "untitled"}
            </div>
            <DiffViewer
              filePath={writeInput.file_path ?? "untitled"}
              original=""
              modified={writeInput.content ?? ""}
              maxHeight={320}
            />
          </>
        )}
        {bashCommand != null && (
          <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)] p-2 text-[color:var(--color-fg)]/90">
            $ {bashCommand}
          </pre>
        )}
        {!editInput && !writeInput && bashCommand == null && (
          <pre className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-elev)] p-2 text-[color:var(--color-fg)]/80">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {/* Blast-radius hint — only renders when classifySeverity matched
            a destructive pattern. Quick orientation for the user without
            forcing them to read the command. */}
        {hint && (
          <div
            className="mt-2 rounded-md border px-2 py-1.5 text-[11px]"
            style={{ borderColor: tint, color: tint }}
          >
            <span className="font-semibold">blast radius · </span>
            {hint}
          </div>
        )}

        {decided ? (
          <div
            className={`mt-3 text-[10px] uppercase tracking-widest ${decided === "allow" ? "text-[color:var(--color-success)]" : "text-[color:var(--color-danger)]"}`}
          >
            {decided === "allow" ? "allowed" : "denied"}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Filled allow button. The previous 10 % opacity success
                fill blended into the panel; allows are committal so
                the click should feel deliberate. */}
            <button
              type="button"
              onClick={allow}
              disabled={busy}
              className="rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)] px-4 py-1.5 font-semibold text-[color:var(--color-bg)] transition hover:opacity-90 disabled:opacity-40"
            >
              allow
            </button>
            {!showDeny ? (
              <button
                type="button"
                onClick={() => setShowDeny(true)}
                disabled={busy}
                className="rounded-md border px-3 py-1.5 transition disabled:opacity-40"
                style={{
                  borderColor: tint,
                  color: tint,
                  background: severity === "danger"
                    ? "oklch(0.6 0.18 25 / 0.10)"
                    : "transparent",
                }}
              >
                deny
              </button>
            ) : (
              <div className="flex flex-1 items-center gap-2">
                <input
                  type="text"
                  value={denyNote}
                  onChange={(e) => setDenyNote(e.target.value)}
                  placeholder="optional note for MARVIN"
                  autoFocus
                  className="flex-1 rounded-md border border-[color:var(--color-border)] bg-transparent px-2 py-1 text-[11px] text-[color:var(--color-fg)] outline-none focus:border-[color:var(--color-danger)]/50"
                />
                <button
                  type="button"
                  onClick={deny}
                  disabled={busy}
                  className="rounded-md px-3 py-1 font-semibold transition disabled:opacity-40"
                  style={{
                    background: tint,
                    color: severity === "danger" ? "white" : "oklch(0.18 0.06 70)",
                  }}
                >
                  send deny
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowDeny(false);
                    setDenyNote("");
                  }}
                  disabled={busy}
                  className="text-[color:var(--color-fg-faint)] hover:text-[color:var(--color-fg)] disabled:opacity-40"
                  aria-label="cancel"
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
