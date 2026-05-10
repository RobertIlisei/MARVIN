/**
 * Suggestion rules — fingerprint tag → suggested skill (ADR-0025).
 *
 * Hand-curated table mapping the namespaced tags emitted by
 * `project-context/fingerprint.ts` to a skill the user should consider
 * installing or building. Two-verb output:
 *
 *   - **install** → user-global skill in `~/.claude/skills/`.
 *     Already exists in the ecosystem; user just needs to run the
 *     install command.
 *   - **build** → project-local skill in `<workDir>/.marvin/skills/`.
 *     Doesn't exist as a generic; the project's stack/domain is
 *     specific enough that it has to be authored for the project.
 *
 * Rules can require additional tags (`requiresAlsoTag`) to narrow the
 * match — e.g. `flyway-multi-tenant-migrations` only makes sense when
 * BOTH `integration:flyway` AND `architecture:multi-tenant` are
 * present, not for any old Flyway project.
 *
 * Adding a new rule: keep `rationale` short (one sentence), keep
 * `verb` honest (don't suggest "install" for a skill that doesn't
 * exist user-global), and prefer specific match-tags over broad ones.
 * The table is intentionally small — adding 50 rules to cover every
 * possible skill is the wrong shape; fewer high-quality rules win.
 */

export type SuggestionVerb = "install" | "build";

export interface SuggestionRule {
  /** The fingerprint tag this rule fires on. */
  matchTag: string;
  /** Optional second tag that must also be present. */
  requiresAlsoTag?: string;
  /** Skill name as it would appear in `~/.claude/skills/<name>/` or
   *  `<workDir>/.marvin/skills/<name>/`. */
  suggest: string;
  /** Whether the suggestion is to install (user-global) or build
   *  (project-local). */
  verb: SuggestionVerb;
  /** One-sentence rationale shown in the "why?" popover. */
  rationale: string;
}

export const SUGGESTION_RULES: SuggestionRule[] = [
  // ── Install (user-global, already exists in the ecosystem) ────────

  {
    matchTag: "test:playwright",
    suggest: "webapp-testing",
    verb: "install",
    rationale:
      "Project uses Playwright; webapp-testing scaffolds new auth-aware E2E tests.",
  },
  {
    matchTag: "framework:react",
    suggest: "frontend-design",
    verb: "install",
    rationale:
      "React project; frontend-design avoids generic Inter/Roboto/purple-gradient defaults when you have aesthetic latitude.",
  },
  {
    matchTag: "framework:next",
    suggest: "frontend-design",
    verb: "install",
    rationale:
      "Next.js project; frontend-design helps with React UI shape decisions.",
  },
  {
    matchTag: "framework:vite",
    suggest: "frontend-design",
    verb: "install",
    rationale:
      "Vite frontend; frontend-design gives you taste guardrails on UI work.",
  },
  {
    matchTag: "integration:claude-agent-sdk",
    suggest: "claude-api",
    verb: "install",
    rationale:
      "Project uses the Claude Agent SDK; claude-api carries SDK shape, hook system, and tool-policy guidance.",
  },
  {
    matchTag: "integration:anthropic-sdk",
    suggest: "claude-api",
    verb: "install",
    rationale:
      "Anthropic SDK in use; claude-api covers the message API + tool-use shape.",
  },
  // pdf / xlsx are user-global Anthropic skills that are surprisingly
  // load-bearing in projects that look "just" like a backend.
  {
    matchTag: "integration:postgresql",
    suggest: "pdf",
    verb: "install",
    rationale:
      "Backend with a database often produces PDF reports — install pdf if you generate compliance docs, invoices, or evidence packs.",
    requiresAlsoTag: "language:java",
  },
  {
    matchTag: "domain:vertical-tax-compliance",
    suggest: "pdf",
    verb: "install",
    rationale:
      "regulatory compliance reports (NITRATES, CAP, PPP) render as PDF — install the pdf skill for layout fidelity.",
  },
  {
    matchTag: "domain:vertical-tax-compliance",
    suggest: "xlsx",
    verb: "install",
    rationale:
      "vertical-domain tenants import subsidy-registry CSVs and export crop data as Excel — install xlsx for the round-trip.",
  },
  // Generic engineering skills that apply broadly. We don't suggest
  // these on every project because spam — only when the fingerprint
  // hints at a real testing/security/PR culture.
  {
    matchTag: "test:vitest",
    suggest: "test-driven-development",
    verb: "install",
    rationale:
      "Vitest in place; TDD skill shapes RED-GREEN-REFACTOR loops well with it.",
  },
  {
    matchTag: "test:testcontainers",
    suggest: "test-driven-development",
    verb: "install",
    rationale:
      "Testcontainers integration tests; TDD skill helps structure the smoke vs unit split.",
  },
  {
    matchTag: "infra:github-actions",
    suggest: "pr-review",
    verb: "install",
    rationale:
      "PR-driven workflow visible (CI on GitHub); pr-review shapes the review-then-merge cadence.",
  },
  {
    matchTag: "compliance:gdpr",
    suggest: "security-audit",
    verb: "install",
    rationale:
      "GDPR signals in this project; security-audit goes deeper than `/security-review` for auth/persistence.",
  },
  {
    matchTag: "integration:auth-rbac",
    suggest: "security-audit",
    verb: "install",
    rationale:
      "RBAC + OIDC in use; security-audit catches multi-tenant authorisation gaps.",
  },
  {
    matchTag: "integration:secrets-manager",
    suggest: "security-audit",
    verb: "install",
    rationale:
      "Project uses a secrets manager (Vault/OpenBao); security-audit is right when the threat model includes credentials.",
  },

  // ── Build (project-local, has to be authored for the stack) ────────

  {
    matchTag: "architecture:spring-modulith",
    suggest: "spring-modulith-architecture",
    verb: "build",
    rationale:
      "Spring Modulith enforces module boundaries via ArchUnit. A project-local skill encodes the rules + scaffolds new modules.",
  },
  {
    matchTag: "integration:flyway",
    requiresAlsoTag: "architecture:multi-tenant",
    suggest: "flyway-multi-tenant-migrations",
    verb: "build",
    rationale:
      "Multi-tenant Flyway needs dual-track schema discipline (global + per-tenant). A project-local skill captures the gotchas.",
  },
  {
    matchTag: "test:playwright",
    requiresAlsoTag: "integration:auth-rbac",
    suggest: "playwright-golden-path",
    verb: "build",
    rationale:
      "Auth-protected Playwright tests need an OIDC fixture pattern — a project-local scaffolder removes the boilerplate per test.",
  },
  {
    matchTag: "workflow:openapi-first",
    suggest: "openapi-first-codegen",
    verb: "build",
    rationale:
      "OpenAPI-first pipeline (spec → server stubs + client + types). A project-local skill drives the regenerate-and-reconcile loop.",
  },
  {
    matchTag: "integration:postgis",
    suggest: "postgis-geospatial",
    verb: "build",
    rationale:
      "PostGIS work needs SRID discipline + GeoJSON↔JTS conversion — project-shaped skill captures the patterns the project actually uses.",
  },
  {
    matchTag: "observability:otel-micrometer",
    suggest: "grafana-otel-dashboard",
    verb: "build",
    rationale:
      "OTel + Micrometer in place. A project-local skill knows the trap (avoid opentelemetry-spring-boot-starter) and scaffolds new dashboards.",
  },
  {
    matchTag: "integration:secrets-manager",
    suggest: "openbao-secrets-runbook",
    verb: "build",
    rationale:
      "Secrets-manager workflow has project-specific token-rotation cadence; capture it as a runnable skill.",
  },
  {
    matchTag: "infra:terraform",
    requiresAlsoTag: "infra:ansible",
    suggest: "deploy-runbook",
    verb: "build",
    rationale:
      "Terraform + Ansible orchestration has a specific apply→provision→deploy ordering — a project-local skill sequences it.",
  },
  {
    matchTag: "domain:vertical-tax-compliance",
    suggest: "vertical-e-invoicing-ubl21",
    verb: "build",
    rationale:
      "e-invoicing UBL 2.1 / standards validation is highly specific; a project-local skill knows your invoice-line edge cases.",
  },
  {
    matchTag: "workflow:grant-evidence",
    suggest: "evidence-pack-runbook",
    verb: "build",
    rationale:
      "grant-program/funding-program milestone deliverables need a deterministic evidence-bundle process. Capture it as a runnable skill.",
  },
  {
    matchTag: "compliance:gdpr",
    suggest: "gdpr-erasure-runbook",
    verb: "build",
    rationale:
      "GDPR Art.17 erasure has project-specific data dependencies — capture them as a skill so the next request doesn't re-derive.",
  },
  {
    matchTag: "architecture:multi-tenant",
    requiresAlsoTag: "integration:auth-rbac",
    suggest: "tenant-rbac-capability",
    verb: "build",
    rationale:
      "Multi-tenant + RBAC is the highest-bug-density area in any SaaS. A project-local skill enforces the isolation rule on every new endpoint.",
  },
  {
    matchTag: "integration:treesitter",
    suggest: "treesitter-language-binding",
    verb: "build",
    rationale:
      "Tree-sitter integrations have per-language quirks (external scanners, parser.c generation). A project-local skill captures which workarounds your project depends on.",
  },
];

/**
 * Apply rules deterministically against a fingerprint. Returns the
 * matched suggestions in declaration order so the UI shows them in a
 * stable sequence.
 *
 * The match logic:
 *   1. `matchTag` MUST be present in the fingerprint.
 *   2. `requiresAlsoTag` (if set) MUST also be present.
 *   3. We never duplicate a `suggest` — the first matching rule wins.
 */
export function applySuggestionRules(tags: string[]): Array<{
  rule: SuggestionRule;
  matchedTags: string[];
}> {
  const tagSet = new Set(tags);
  const suggested = new Set<string>();
  const out: Array<{ rule: SuggestionRule; matchedTags: string[] }> = [];
  for (const rule of SUGGESTION_RULES) {
    if (suggested.has(rule.suggest)) continue;
    if (!tagSet.has(rule.matchTag)) continue;
    if (rule.requiresAlsoTag && !tagSet.has(rule.requiresAlsoTag)) continue;
    const matchedTags = rule.requiresAlsoTag
      ? [rule.matchTag, rule.requiresAlsoTag]
      : [rule.matchTag];
    out.push({ rule, matchedTags });
    suggested.add(rule.suggest);
  }
  return out;
}
