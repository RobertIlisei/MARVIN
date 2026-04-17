import { execFile } from "child_process";
import { promisify } from "util";

/**
 * Infra reality probes — run the canonical list of dev-env services listed in
 * BUSINESS_OVERVIEW.md § Development & Infrastructure and return their up/down
 * status as a machine-readable block that gets injected into tech-lead and
 * engineer dispatch prompts.
 *
 * Why this exists: agents had a spec that LISTED Keycloak/Postgres/Mosquitto/
 * etc., but no signal about whether each service was actually running. Tech-lead
 * would decompose a Story like "Automate-tier subscription gating via Keycloak
 * roles" into engineering Tasks without noticing that Keycloak wasn't even in
 * docker-compose.yml. Appending a "DOWN/UP" checklist to the dispatch context
 * makes the gap structural, not anecdotal.
 *
 * Each probe has a 3-second timeout. Full sweep is <4 seconds in the common case.
 * Safe to call on every dispatch that goes through buildDispatchContext.
 */

const pExecFile = promisify(execFile);

export interface InfraProbe {
  service: string;
  url?: string;
  status: "up" | "down" | "unknown";
  detail?: string;
}

async function probeHttp(
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
      return { service, url, status: "down", detail: `responded but missing marker "${matchSubstring}"` };
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

async function probeDockerContainer(
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

/**
 * Run all probes in parallel. Returns a list the caller can render into a block.
 * Does NOT throw — any individual probe failure becomes a `status: "down"` entry.
 */
export async function runInfraProbes(): Promise<InfraProbe[]> {
  return Promise.all([
    probeHttp(
      "Keycloak",
      "http://localhost:8080/realms/greenstack/.well-known/openid-configuration",
      "issuer",
    ),
    probeDockerContainer("Postgres / TimescaleDB", /(greenstack-db|timescaledb|postgres)/i),
    probeHttp("Unleash (feature flags)", "http://localhost:4242/health"),
    probeDockerContainer("Mosquitto MQTT broker", /mosquitto/i),
    probeDockerContainer("Redis", /redis/i),
    probeHttp("Traefik dashboard", "http://localhost:8082/api/overview"),
    probeDockerContainer("MinIO", /minio/i),
    probeHttp("Prometheus", "http://localhost:9090/-/healthy"),
    probeHttp("Grafana", "http://localhost:3000/api/health"),
    probeDockerContainer("Loki", /loki/i),
    probeDockerContainer("MailHog", /mailhog/i),
  ]);
}

/**
 * Render probe results as a context block ready to prepend to a dispatch message.
 * DOWN services are listed first; UP services summarized briefly.
 */
export function formatProbeBlock(probes: InfraProbe[]): string {
  if (probes.length === 0) return "";
  const down = probes.filter((p) => p.status === "down");
  const up = probes.filter((p) => p.status === "up");
  const unknown = probes.filter((p) => p.status === "unknown");

  const lines: string[] = [];
  lines.push("## Infra reality (auto-probed at dispatch time)");
  lines.push("");
  if (down.length > 0) {
    lines.push(`### ⚠ DOWN (${down.length})`);
    for (const p of down) {
      lines.push(
        `- **${p.service}**${p.url ? ` \`${p.url}\`` : ""} — ${p.detail ?? "unreachable"}`,
      );
    }
    lines.push("");
  }
  if (up.length > 0) {
    lines.push(`### ✓ UP (${up.length})`);
    for (const p of up) {
      lines.push(`- ${p.service}${p.url ? ` \`${p.url}\`` : ""}`);
    }
    lines.push("");
  }
  if (unknown.length > 0) {
    lines.push(`### ? UNKNOWN (${unknown.length})`);
    for (const p of unknown) {
      lines.push(`- ${p.service} — ${p.detail ?? ""}`);
    }
    lines.push("");
  }
  lines.push(
    "> **Acting on this:** if a DOWN service is required by your task's scope, call `jarvis_add_task_blocker` with the failing probe output and set status to `blocked`. Do not write speculative code against a non-running dependency — the output cannot be verified.",
  );
  return lines.join("\n") + "\n\n---\n\n";
}

/**
 * Convenience — probe + format in one call. Returns an empty string if probes
 * fail to run (never throws).
 */
export async function buildInfraProbeBlock(): Promise<string> {
  try {
    const probes = await runInfraProbes();
    return formatProbeBlock(probes);
  } catch {
    return "";
  }
}
