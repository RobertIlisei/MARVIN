/**
 * Infra reality probes — project-agnostic primitives.
 *
 * MARVIN does not ship a hardcoded service list. The previous incarnation
 * knew about Keycloak / Postgres / Unleash / Mosquitto / Redis / etc. because
 * it was tied to one specific project. That's exactly the coupling we're
 * removing.
 *
 * How to use them now:
 *
 *   - Call `probeHttp(name, url)` and `probeDockerContainer(name, pattern)`
 *     from wherever you want probes (e.g. a per-project config hook in
 *     Phase 2+).
 *   - Assemble a list of `InfraProbe`s, hand them to `runProbes()` to get
 *     results, and `formatProbeBlock()` to render a markdown summary.
 *
 * A new project has ZERO probes by default. You (or a config file in the
 * project's workDir) add them when there are real services to watch.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const pExecFile = promisify(execFile);

export interface InfraProbe {
  service: string;
  url?: string;
  status: "up" | "down" | "unknown";
  detail?: string;
}

export async function probeHttp(
  service: string,
  url: string,
  matchSubstring?: string,
): Promise<InfraProbe> {
  try {
    const { stdout } = await pExecFile(
      "curl",
      ["-sf", "--max-time", "3", url],
      { timeout: 4000 },
    );
    if (matchSubstring && !stdout.includes(matchSubstring)) {
      return {
        service,
        url,
        status: "down",
        detail: `responded but missing marker "${matchSubstring}"`,
      };
    }
    return { service, url, status: "up" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      service,
      url,
      status: "down",
      detail: msg.includes("timed out") ? "timeout" : "unreachable",
    };
  }
}

export async function probeDockerContainer(
  service: string,
  namePattern: RegExp,
): Promise<InfraProbe> {
  try {
    const { stdout } = await pExecFile(
      "docker",
      ["ps", "--format", "{{.Names}}\t{{.Status}}"],
      { timeout: 3000 },
    );
    const matches = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => namePattern.test(l));
    const first = matches[0];
    if (!first) {
      return { service, status: "down", detail: "no matching container running" };
    }
    const healthy = matches.find((m) => /Up\s.*\b(healthy)\b/.test(m)) ?? first;
    if (/Up\b/.test(healthy)) {
      return { service, status: "up", detail: healthy.split("\t")[0] ?? healthy };
    }
    return { service, status: "down", detail: healthy };
  } catch {
    return { service, status: "unknown", detail: "docker CLI not available" };
  }
}

/** Run a caller-supplied list of probes in parallel. Empty list → `[]`. */
export async function runProbes(
  probes: Array<() => Promise<InfraProbe>>,
): Promise<InfraProbe[]> {
  if (probes.length === 0) return [];
  return Promise.all(probes.map((p) => p()));
}

/**
 * Render probe results as a markdown block suitable for injection into the
 * MARVIN system prompt. Returns `""` for an empty probe list (zero
 * project-agnostic baseline).
 */
export function formatProbeBlock(probes: InfraProbe[]): string {
  if (probes.length === 0) return "";
  const down = probes.filter((p) => p.status === "down");
  const up = probes.filter((p) => p.status === "up");
  const unknown = probes.filter((p) => p.status === "unknown");

  const lines: string[] = [];
  lines.push("## Infra reality (auto-probed at session start)");
  lines.push("");
  if (down.length > 0) {
    lines.push(`### DOWN (${down.length})`);
    for (const p of down) {
      lines.push(
        `- **${p.service}**${p.url ? ` \`${p.url}\`` : ""} — ${p.detail ?? "unreachable"}`,
      );
    }
    lines.push("");
  }
  if (up.length > 0) {
    lines.push(`### UP (${up.length})`);
    for (const p of up) {
      lines.push(`- ${p.service}${p.url ? ` \`${p.url}\`` : ""}`);
    }
    lines.push("");
  }
  if (unknown.length > 0) {
    lines.push(`### UNKNOWN (${unknown.length})`);
    for (const p of unknown) {
      lines.push(`- ${p.service} — ${p.detail ?? ""}`);
    }
    lines.push("");
  }
  lines.push(
    "> **If a DOWN service is required for the work at hand, flag it to the user and wait for confirmation before writing code that depends on it.**",
  );
  return lines.join("\n") + "\n\n---\n\n";
}
