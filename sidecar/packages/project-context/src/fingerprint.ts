/**
 * Project fingerprint — what KIND of project is this?
 *
 * Pure-FS, deterministic, no LLM call. On project open, scan top-level
 * signals and emit a typed `ProjectFingerprint` with namespaced tags.
 * The fingerprint feeds the skill-recommendation engine in
 * `runtime/src/skill-catalog.ts` (per ADR-0024).
 *
 * Counterpart to `workflow-health.ts`:
 *   - workflow-health is **project-agnostic** — checks the four MARVIN
 *     deliverables (ADRs, memory, graph, freshness) regardless of stack.
 *   - fingerprint is **project-aware** — its job is to recognise stack,
 *     framework, architecture, and domain so suggestions can be tuned.
 *
 * Both modules ship structured data + a `format…Block` pair so
 * `buildProjectContext` can compose them.
 *
 * Tags are intentionally namespaced (`language:typescript`,
 * `framework:next@16`, `architecture:multi-tenant`,
 * `compliance:gdpr`). Namespacing is what lets the catalog match
 * without ambiguity — there's no risk of confusing a `framework:react`
 * skill with a `language:c` one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ProjectFingerprint {
  /** Absolute workDir the detector was run against. */
  workDir: string;
  /** ISO timestamp of when this fingerprint was produced. */
  detectedAt: string;
  /** Namespaced tags. See module-level docs for the conventions. */
  tags: string[];
  /** Per-namespace breakdown — convenience for the catalog query path. */
  byNamespace: Record<string, string[]>;
  /** True when the project has enough substance for the fingerprint
   *  to be meaningful. Empty repos / single-file sketches return false. */
  hasSubstance: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  "dist",
  "build",
  "target",
  "out",
  "venv",
  ".venv",
  "__pycache__",
  "coverage",
  ".cache",
  "graphify-out",
  "vendor",
]);

/**
 * Best-effort file read with a size cap. Returns `null` on any failure.
 * The cap matters: package-lock.json can be MB-scale and we only ever
 * grep top-level dep names from it. 256 KB is enough for every
 * mainstream manifest format.
 */
function readSmall(path: string, cap = 256 * 1024): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const buf = readFileSync(path, { encoding: "utf-8" });
    return buf.length > cap ? buf.slice(0, cap) : buf;
  } catch {
    return null;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function dirHasFiles(workDir: string, rel: string, minFiles = 1): boolean {
  try {
    const full = join(workDir, rel);
    const st = statSync(full);
    if (!st.isDirectory()) return false;
    const entries = readdirSync(full).filter((n) => !n.startsWith("."));
    return entries.length >= minFiles;
  } catch {
    return false;
  }
}

function hasFileMatching(
  workDir: string,
  rel: string,
  pattern: RegExp,
  minMatches = 1,
): boolean {
  try {
    const full = join(workDir, rel);
    const st = statSync(full);
    if (!st.isDirectory()) return false;
    let count = 0;
    for (const name of readdirSync(full)) {
      if (pattern.test(name)) {
        count += 1;
        if (count >= minMatches) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Walk the repo bounded by `maxEntries`, mirroring `workflow-health`.
 * We share the bound so a fingerprint pass costs roughly the same as a
 * workflow-health pass — both run on every first-message turn.
 */
function fileCountInRepo(root: string, maxEntries = 4000): number {
  let fileCount = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && fileCount < maxEntries) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (fileCount >= maxEntries) break;
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".") && name !== ".github") continue;
      const full = `${dir}/${name}`;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        fileCount += 1;
      }
    }
  }
  return fileCount;
}

/**
 * Sniff `package.json` for stack / framework signals. We only inspect
 * the top-level `dependencies` + `devDependencies` keys; transitive
 * deps don't tell us what the user is *building*, only what the build
 * graph happens to need.
 */
function tagsFromPackageJson(text: string): string[] {
  const tags: string[] = [];
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    type?: string;
  };
  try {
    pkg = JSON.parse(text);
  } catch {
    return tags;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const has = (name: string) => Object.hasOwn(deps, name);
  const ver = (name: string) => deps[name];

  tags.push("language:typescript-or-javascript");
  if (pkg.type === "module") tags.push("module-system:esm");

  // Frameworks. The matrix is finite; pattern is "the dep that
  // unambiguously tells you *what kind of app this is*".
  if (has("next")) tags.push(`framework:next@${majorOf(ver("next"))}`);
  if (has("vite")) tags.push(`framework:vite@${majorOf(ver("vite"))}`);
  if (has("react")) tags.push(`framework:react@${majorOf(ver("react"))}`);
  if (has("vue")) tags.push(`framework:vue@${majorOf(ver("vue"))}`);
  if (has("svelte")) tags.push(`framework:svelte@${majorOf(ver("svelte"))}`);
  if (has("@nestjs/core")) tags.push("framework:nestjs");
  if (has("express")) tags.push("framework:express");
  if (has("fastify")) tags.push("framework:fastify");
  if (has("expo")) tags.push("framework:expo");
  if (has("react-native")) tags.push("framework:react-native");
  if (has("electron")) tags.push("framework:electron");
  if (has("@tauri-apps/api")) tags.push("framework:tauri");

  // UI / state libs that tell you about the shape of the app.
  if (has("@tanstack/react-query")) tags.push("ui:react-query");
  if (has("@tanstack/react-table")) tags.push("ui:react-table");
  if (has("@radix-ui/react-dialog")) tags.push("ui:radix");
  if (has("tailwindcss")) tags.push("ui:tailwind");
  if (has("react-hook-form")) tags.push("ui:react-hook-form");
  if (has("zod")) tags.push("ui:zod");
  if (has("i18next")) tags.push("ui:i18next");

  // Test stack.
  if (has("vitest")) tags.push("test:vitest");
  if (has("jest")) tags.push("test:jest");
  if (has("@playwright/test") || has("playwright")) {
    tags.push("test:playwright");
  }
  if (has("cypress")) tags.push("test:cypress");

  // Build / packaging tells.
  if (has("turbo")) tags.push("build:turbo");
  if (has("nx")) tags.push("build:nx");
  if (has("@anthropic-ai/claude-agent-sdk")) {
    tags.push("integration:claude-agent-sdk");
  }
  if (has("@anthropic-ai/sdk")) tags.push("integration:anthropic-sdk");

  return tags;
}

function majorOf(version: string | undefined): string {
  if (!version) return "?";
  const m = version.match(/(\d+)/);
  return m && m[1] ? m[1] : "?";
}

/**
 * Sniff `pom.xml` for Spring Boot / Modulith / PostGIS / common Java
 * markers. Tags emit even on shallow matches — `<artifactId>foo</…>`
 * substring suffices because pom.xml is structured enough that false
 * positives are rare.
 */
function tagsFromPom(text: string): string[] {
  const tags: string[] = [];
  tags.push("language:java");
  tags.push("build:maven");
  if (/spring-boot-starter-parent/.test(text)) tags.push("framework:spring-boot");
  if (/spring-modulith/.test(text)) tags.push("architecture:spring-modulith");
  if (/spring-cloud-bom/.test(text)) tags.push("framework:spring-cloud");
  if (/spring-boot-starter-data-jpa/.test(text)) tags.push("integration:jpa");
  if (/spring-boot-starter-security/.test(text)) tags.push("integration:spring-security");
  if (/spring-boot-starter-oauth2/.test(text)) tags.push("integration:oauth2");
  if (/postgresql/.test(text)) tags.push("integration:postgresql");
  if (/postgis|jts-core|geolatte-geom/.test(text)) tags.push("integration:postgis");
  if (/flyway/.test(text)) tags.push("integration:flyway");
  if (/liquibase/.test(text)) tags.push("integration:liquibase");
  if (/io\.minio/.test(text)) tags.push("integration:minio");
  if (/aws-sdk/.test(text)) tags.push("integration:aws-sdk");
  if (/testcontainers/.test(text)) tags.push("test:testcontainers");
  if (/micrometer-tracing-bridge-otel/.test(text)) tags.push("observability:otel-micrometer");
  if (/mapstruct/.test(text)) tags.push("integration:mapstruct");
  if (/openapi-generator/.test(text)) tags.push("workflow:openapi-first");
  if (/error_prone|errorprone/i.test(text)) tags.push("quality:errorprone");
  if (/nullaway/i.test(text)) tags.push("quality:nullaway");
  return tags;
}

function tagsFromGradle(text: string): string[] {
  const tags: string[] = [];
  tags.push("language:java-or-kotlin");
  tags.push("build:gradle");
  if (/org\.springframework\.boot/.test(text)) tags.push("framework:spring-boot");
  if (/kotlin\(/.test(text) || /kotlin-stdlib/.test(text)) {
    tags.push("language:kotlin");
  }
  return tags;
}

function tagsFromCargo(text: string): string[] {
  const tags: string[] = ["language:rust", "build:cargo"];
  if (/axum\s*=/.test(text)) tags.push("framework:axum");
  if (/actix-web\s*=/.test(text)) tags.push("framework:actix");
  if (/rocket\s*=/.test(text)) tags.push("framework:rocket");
  if (/tauri\s*=/.test(text)) tags.push("framework:tauri");
  if (/tokio\s*=/.test(text)) tags.push("integration:tokio");
  if (/sqlx\s*=/.test(text)) tags.push("integration:sqlx");
  if (/serde\s*=/.test(text)) tags.push("integration:serde");
  return tags;
}

function tagsFromGoMod(text: string): string[] {
  const tags: string[] = ["language:go", "build:go-modules"];
  if (/github\.com\/gin-gonic\/gin/.test(text)) tags.push("framework:gin");
  if (/github\.com\/labstack\/echo/.test(text)) tags.push("framework:echo");
  if (/github\.com\/go-chi\/chi/.test(text)) tags.push("framework:chi");
  if (/google\.golang\.org\/grpc/.test(text)) tags.push("integration:grpc");
  return tags;
}

function tagsFromPyProject(text: string): string[] {
  const tags: string[] = ["language:python"];
  if (/poetry/.test(text)) tags.push("build:poetry");
  if (/hatchling/.test(text)) tags.push("build:hatch");
  if (/setuptools/.test(text)) tags.push("build:setuptools");
  if (/fastapi/.test(text)) tags.push("framework:fastapi");
  if (/django/.test(text)) tags.push("framework:django");
  if (/flask/.test(text)) tags.push("framework:flask");
  if (/sqlalchemy/.test(text)) tags.push("integration:sqlalchemy");
  if (/alembic/.test(text)) tags.push("integration:alembic");
  if (/pydantic/.test(text)) tags.push("integration:pydantic");
  if (/pandas|polars|numpy/.test(text)) tags.push("domain:data-analysis");
  if (/torch|tensorflow|jax/.test(text)) tags.push("domain:machine-learning");
  if (/pytest/.test(text)) tags.push("test:pytest");
  return tags;
}

function tagsFromSwiftPackage(text: string): string[] {
  const tags: string[] = ["language:swift", "build:spm"];
  if (/STTextView/.test(text)) tags.push("integration:sttextview");
  if (/SwiftTreeSitter/.test(text)) tags.push("integration:treesitter");
  return tags;
}

function tagsFromGemfile(text: string): string[] {
  const tags: string[] = ["language:ruby", "build:bundler"];
  if (/['"]rails['"]/.test(text)) tags.push("framework:rails");
  if (/['"]sinatra['"]/.test(text)) tags.push("framework:sinatra");
  return tags;
}

/**
 * Architecture / repo-shape signals — independent of language.
 */
function architectureTags(workDir: string): string[] {
  const tags: string[] = [];
  if (dirHasFiles(workDir, "apps", 2)) tags.push("architecture:monorepo");
  if (
    exists(join(workDir, "pnpm-workspace.yaml")) ||
    exists(join(workDir, "lerna.json")) ||
    exists(join(workDir, "turbo.json"))
  ) {
    tags.push("architecture:workspace");
  }
  if (exists(join(workDir, "docker-compose.yml")) ||
      exists(join(workDir, "docker-compose.yaml"))) {
    tags.push("infra:docker-compose");
  }
  if (dirHasFiles(workDir, "infrastructure/terraform", 1) ||
      dirHasFiles(workDir, "terraform", 1) ||
      hasFileMatching(workDir, "infra", /\.tf$/)) {
    tags.push("infra:terraform");
  }
  if (dirHasFiles(workDir, "infrastructure/ansible", 1) ||
      dirHasFiles(workDir, "ansible", 1)) {
    tags.push("infra:ansible");
  }
  if (dirHasFiles(workDir, ".github/workflows", 1)) {
    tags.push("infra:github-actions");
  }
  if (dirHasFiles(workDir, "infrastructure/grafana/dashboards", 1) ||
      dirHasFiles(workDir, "grafana", 1)) {
    tags.push("observability:grafana-stack");
  }
  return tags;
}

/**
 * Multi-tenancy / RBAC / compliance signals — read from
 * `.marvin/memory.md` + ADR titles. These are the highest-value tags
 * because they unlock the entire "Build/edit project-shaped skill"
 * branch of the suggestion engine.
 */
function domainTagsFromContext(workDir: string): string[] {
  const tags = new Set<string>();
  const sources: string[] = [];

  const memory = readSmall(join(workDir, ".marvin", "memory.md"));
  if (memory) sources.push(memory);

  const adrDirs = ["docs/adr", "docs/adrs", "docs/decisions"];
  for (const rel of adrDirs) {
    try {
      const full = join(workDir, rel);
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      for (const name of readdirSync(full)) {
        if (!name.endsWith(".md") || name.toUpperCase().startsWith("README")) {
          continue;
        }
        // Title-only scan — content scan would be too much for this
        // path. The filename itself is a strong signal in MARVIN-style
        // repos (`0023-brew-distributable-bundled-sidecar.md`).
        sources.push(name.replace(/\.md$/, ""));
      }
    } catch {
      /* skip */
    }
  }

  const hay = sources.join(" ").toLowerCase();

  if (/multi-tenant|multitenant|per-tenant/.test(hay)) {
    tags.add("architecture:multi-tenant");
  }
  if (/rbac|authentik|oidc|oauth2|jwt/.test(hay)) {
    tags.add("integration:auth-rbac");
  }
  if (/gdpr|art\.17|erasure/.test(hay)) tags.add("compliance:gdpr");
  if (/hipaa/.test(hay)) tags.add("compliance:hipaa");
  if (/pci|pci-dss/.test(hay)) tags.add("compliance:pci");
  if (/sox/.test(hay)) tags.add("compliance:sox");
  if (/postgis|geospatial|geometry|geojson/.test(hay)) {
    tags.add("integration:postgis");
  }
  if (/openbao|vault|secrets/.test(hay)) tags.add("integration:secrets-manager");
  if (/grant|milestone/.test(hay)) {
    tags.add("workflow:grant-evidence");
  }
  return [...tags];
}

/**
 * Top-level entry point. ~Cheap (a handful of small file reads + one
 * walk capped at 4000 entries). Safe to call on every first-turn.
 */
export function detectFingerprint(workDir: string): ProjectFingerprint {
  const tags = new Set<string>();

  // package.json — the most common entry point. Multiple package.json
  // files in a workspace are deduplicated by the Set.
  const pkgPaths = [
    "package.json",
    "apps/web/package.json",
    "apps/api/package.json",
    "sidecar/package.json",
  ];
  for (const rel of pkgPaths) {
    const text = readSmall(join(workDir, rel));
    if (text) tagsFromPackageJson(text).forEach((t) => tags.add(t));
  }

  const pomPaths = ["pom.xml", "apps/api/pom.xml", "api/pom.xml"];
  for (const rel of pomPaths) {
    const text = readSmall(join(workDir, rel));
    if (text) tagsFromPom(text).forEach((t) => tags.add(t));
  }

  const gradlePaths = [
    "build.gradle",
    "build.gradle.kts",
    "apps/api/build.gradle.kts",
  ];
  for (const rel of gradlePaths) {
    const text = readSmall(join(workDir, rel));
    if (text) tagsFromGradle(text).forEach((t) => tags.add(t));
  }

  const cargoText = readSmall(join(workDir, "Cargo.toml"));
  if (cargoText) tagsFromCargo(cargoText).forEach((t) => tags.add(t));

  const goModText = readSmall(join(workDir, "go.mod"));
  if (goModText) tagsFromGoMod(goModText).forEach((t) => tags.add(t));

  const pyProjectText = readSmall(join(workDir, "pyproject.toml"));
  if (pyProjectText) tagsFromPyProject(pyProjectText).forEach((t) => tags.add(t));

  const swiftPkgText = readSmall(join(workDir, "Package.swift")) ??
                       readSmall(join(workDir, "macos/Package.swift"));
  if (swiftPkgText) tagsFromSwiftPackage(swiftPkgText).forEach((t) => tags.add(t));

  const gemfileText = readSmall(join(workDir, "Gemfile"));
  if (gemfileText) tagsFromGemfile(gemfileText).forEach((t) => tags.add(t));

  architectureTags(workDir).forEach((t) => tags.add(t));
  domainTagsFromContext(workDir).forEach((t) => tags.add(t));

  // Substance gate — same threshold as workflow-health uses.
  const fileCount = fileCountInRepo(workDir);
  const hasSubstance = fileCount >= 4;

  // Bucket by namespace for the catalog query path.
  const byNamespace: Record<string, string[]> = {};
  for (const t of tags) {
    const sep = t.indexOf(":");
    const ns = sep > 0 ? t.slice(0, sep) : "_";
    (byNamespace[ns] ??= []).push(t);
  }

  return {
    workDir,
    detectedAt: new Date().toISOString(),
    tags: [...tags].sort(),
    byNamespace,
    hasSubstance,
  };
}

/**
 * Markdown block for the project-context injection. Only renders when
 * the project has substance AND we found at least one tag — otherwise
 * the block is noise (a fresh-init repo doesn't need a fingerprint).
 */
export function formatFingerprintBlock(fp: ProjectFingerprint): string {
  if (!fp.hasSubstance || fp.tags.length === 0) return "";

  const groups = Object.entries(fp.byNamespace).sort();
  const groupLines = groups
    .map(([ns, ts]) => `- **${ns}** — ${ts.map((t) => t.slice(ns.length + 1)).join(", ")}`)
    .join("\n");

  return [
    "## Project fingerprint",
    "",
    "Detected stack / architecture / domain signals from this project:",
    "",
    groupLines,
    "",
    "These tags drive skill recommendations (ADR-0024) — match them to " +
      "the catalog when proposing what to install or build.",
  ].join("\n");
}

/**
 * The audit-pending firm-surface block. Renders when the fingerprint
 * is present but `<workDir>/.marvin/skills.md` is missing — telling
 * MARVIN it owes the user a single recommendation this session.
 *
 * Self-expiring: the moment the file lands on disk, this block stops
 * rendering. The user closes the loop by writing the file (it can be
 * one line: "skills audited 2026-05-11, parked").
 */
export function formatSkillAuditBlock(fp: ProjectFingerprint): string {
  if (!fp.hasSubstance || fp.tags.length === 0) return "";
  const skillsMd = join(fp.workDir, ".marvin", "skills.md");
  if (exists(skillsMd)) return "";

  return [
    "## Skill audit pending",
    "",
    "This project has detected fingerprint tags but no " +
      "`<workDir>/.marvin/skills.md` recording a skill audit decision. " +
      "Per ADR-0024 you owe the user **one** chip-strip recommendation " +
      "this session, then STOP — do not re-recommend until the file " +
      "either lands or the user explicitly asks again.",
    "",
    "Recommendation shape — produce two verbs:",
    "",
    "- **Install** *(user-global skills, `~/.claude/skills/`)* — " +
      "general-purpose capabilities matching `language:*` / `framework:*` / " +
      "`test:*` tags. Once-per-machine action by the user.",
    "- **Build/edit** *(project-local skills, `<workDir>/.marvin/skills/`)* — " +
      "stack-shaped capabilities matching `architecture:*` / `domain:*` / " +
      "`compliance:*` tags. Per-project action committed to this repo.",
    "",
    "Closing the loop: ask the user to capture the decision in " +
      "`<workDir>/.marvin/skills.md`. Even a one-liner (e.g. " +
      "*\"audited 2026-05-11; parked all\"*) makes this block disappear " +
      "next session. That's the user's signal that they've heard the " +
      "audit and made their call.",
  ].join("\n");
}
