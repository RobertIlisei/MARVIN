---
name: security-audit
description: OWASP Top 10 + STRIDE threat model pass on the current codebase, or on the current branch diff. Emits a findings report with severity, confidence, and exploit scenario. Use alongside Claude Code's built-in /security-review for spot checks, and whenever the diff touches auth, credentials, tool policy, shell execution, or data persistence. Adapted from Garry Tan's gstack /cso (garrytan/gstack); role framing stripped.
---

# Security audit

Deep-dive security review. Complementary to Claude Code's built-in
`/security-review` (fast, diff-scoped) and to the `pr-review` skill
(catches critical classes on every PR). Use this skill when:

- The diff materially touches security boundaries — auth, credential
  handling, tool policy, shell execution, network egress, data
  storage.
- The codebase is moving into production / public availability.
- Monthly / quarterly posture review.
- A specific concern ("I want to know whether our session-resume
  flow is safe against replay") — scope with `--diff` or a
  directory.

## Modes

- **Full audit** — all phases, all OWASP categories, STRIDE pass on
  major components. Slow. Use when you have time and want coverage.
- **Diff-scoped** — only analyses changes in the current branch vs
  the base. Fast. Use as a gate before merging security-sensitive
  work.
- **Category-scoped** — `--owasp`, `--supply-chain`, `--infra`,
  `--code`, `--skills`. Mutually exclusive. For targeted dives.

## Phase 1 — Secrets and credential hygiene

Go wide before going deep. Before any logic analysis, confirm the
repo doesn't leak secrets.

- `git log --all -p -S "-----BEGIN"` — look for committed private
  keys in history, even if removed later.
- Grep for common key prefixes: `sk_`, `pk_`, `xoxb-`, `ghp_`,
  `eyJ0eXAi` (JWT header base64).
- `.env` files committed? Even empty files can leak path
  assumptions.
- Hardcoded passwords, tokens, seeds for CSPRNGs.
- Debug flags (`DEBUG_BYPASS_AUTH=true`) left enabled by default.

Findings here → almost always **CRITICAL**. Credentials in git
history don't get un-leaked by deleting the file.

## Phase 2 — Dependency supply chain

- Lockfile drift. Dependencies not pinned to specific versions
  where they should be (`^`, `~`, `latest`). Flag if any dep is
  marked `latest`.
- Known-vulnerable versions. Run `pnpm audit` / `npm audit` and
  summarise by severity. Don't dump the raw output.
- Recently-introduced deps. `git log --follow package.json` and
  surface any new deps added in this PR / recent commits — new
  deps are a supply-chain risk surface.
- Install-time scripts. Deps with `postinstall` scripts are a known
  supply-chain attack vector; flag new ones.

## Phase 3 — CI/CD and infrastructure

- GitHub Actions / CI config using `pull_request_target` (privileged
  runner with code from the PR head — frequent misconfiguration).
- Secrets leaked to logs via `echo $SECRET` or `set -x` bash tracing.
- Deployment pipelines that run user-influenced code before secret
  redaction.
- Cloud IAM — over-permissioned service accounts, wildcard resource
  patterns, admin roles where specific roles would suffice.

For MARVIN: this phase is mostly empty (no CI, no cloud deployment).
Skip and note in the report.

## Phase 4 — OWASP Top 10 application review

Each category gets a targeted pass. Severity depends on exploit
feasibility + data sensitivity.

### A01 — Broken access control

- Endpoints missing auth / authz checks.
- Authorisation decisions made client-side without server
  enforcement.
- Insecure direct object references (IDs in URLs that can be
  enumerated or guessed).
- Path traversal via user input — missing `..` rejection, missing
  realpath checks.

### A02 — Cryptographic failures

- Weak algorithms (MD5, SHA1 for auth, DES, 3DES, ECB mode).
- Hardcoded IVs or salts.
- Random values used for security generated with non-CSPRNG
  (`Math.random`).
- TLS not enforced on outbound requests.

### A03 — Injection

- SQL, NoSQL, LDAP, XPath injection via string concatenation.
- Command injection via `exec`, `spawn`, template-literal shell
  construction.
- HTML injection where user content is rendered into a page without
  escaping (XSS).
- LLM prompt injection where untrusted input influences a prompt that
  then controls tool use.

### A04 — Insecure design

- Sensitive workflows missing rate limits.
- Password reset flows that reveal account existence.
- Business-logic flaws (negative quantity orders, race between
  authorisation and payment).
- Missing threat model for high-value features.

### A05 — Security misconfiguration

- Default credentials in configs.
- Verbose error pages in production.
- CORS wildcards.
- Missing security headers (`Content-Security-Policy`,
  `X-Frame-Options`, `Strict-Transport-Security`).
- Directory listings enabled.

### A06 — Vulnerable and outdated components

See Phase 2.

### A07 — Identification and authentication failures

- Weak password policies.
- Session tokens without expiry.
- Session fixation — reusing session IDs across auth events.
- Missing multi-factor for privileged operations.
- Credential enumeration via timing differences or error messages.

### A08 — Software and data integrity failures

- Deserialisation of untrusted data.
- Auto-update mechanisms without signature verification.
- Third-party scripts loaded without Subresource Integrity.

### A09 — Security logging and monitoring failures

- Security events not logged (failed auth, privilege changes, config
  changes).
- Logs containing secrets (tokens, passwords, PII).
- No audit trail for admin actions.

### A10 — Server-side request forgery

- URLs constructed from user input and then fetched server-side
  without allowlist.
- Server-side redirects with user-controlled destinations.
- Internal-network exposure via SSRF paths.

## Phase 5 — STRIDE threat model on major components

For each major component (service boundary, trust zone), walk STRIDE:

| Dimension | Question |
|---|---|
| **Spoofing** | Can an attacker impersonate users or services to this component? |
| **Tampering** | Can data be modified in transit or at rest, undetected? |
| **Repudiation** | Are actions deniable? Is there an audit trail? |
| **Information disclosure** | Can sensitive data leak — to users, to logs, to other tenants? |
| **Denial of service** | Can the component be overwhelmed? Rate-limited? |
| **Elevation of privilege** | Can a lower-privilege user gain higher privileges? |

MARVIN's major components:

- The Next.js API layer (`apps/web/src/app/api/*`). Local-only, but
  worth reasoning about if the app is ever exposed over network.
- The Agent SDK runner (`packages/runtime/src/sdk-runner.ts`) — the
  trust boundary for tool execution.
- The confirm gate (`canUseTool` callback). The security-relevant
  boundary — a bypass is an EoP.
- The MCP servers (`marvin-graph`, `marvin-playwright`). In-process
  today; STRIDE matters more if they ever become remote.
- The shell spawner (`/api/terminal/run`). Executes user-provided
  commands in the project cwd. High-value threat surface.

## Severity and confidence

- **CRITICAL** — actively exploitable with no significant barrier.
  Ship stoppers.
- **HIGH** — exploitable given specific conditions commonly present
  in real deployments.
- **MEDIUM** — exploitable in narrow conditions or requires
  combining with another flaw.
- **INFORMATIONAL** — not a vulnerability per se, but a hardening
  opportunity.

Confidence (1-10):

- **9-10** — could write a working proof-of-concept.
- **8** — clear vulnerability pattern with documented exploitation.
- **Below 8** — suppress from the daily-mode report; include in
  comprehensive-mode appendix.

## Output format

Report structure:

```
SECURITY AUDIT — <mode> — <date>

Summary: <severity counts, e.g. "2 CRITICAL, 4 HIGH, 7 MEDIUM">

Findings (by severity):

  [CRITICAL] (confidence 9/10) <ID>
  Category:     A03 — Injection
  File:Line:    apps/web/src/app/api/terminal/run/route.ts:47
  Title:        Unescaped command interpolation in shell spawn
  Exploit:      <concrete attack scenario>
  Impact:       <what can go wrong>
  Remediation:  <specific code-level fix>
  Verification: <how you confirmed, or "pattern match, unverified">

  [HIGH] ...

Positive findings (no issues in these areas):
  - Dependency supply chain: audit clean, no postinstall scripts
  - Secrets hygiene: no leaks in history
  ...
```

Save to a timestamped file so runs can be diffed over time.
MARVIN-specific location suggestion: `<workDir>/.marvin/security/<date>.md`.

## Applying to MARVIN specifically

Highest-value surfaces for MARVIN to audit:

1. **Tool policy** (`packages/tools/src/policy.ts`) — auto-allow regex
   list, hard-deny list. A gap here is a direct EoP.
2. **Credential handlers** (`packages/runtime/src/auth.ts`) — token
   readers, Keychain access, env var fallback. Leakage into logs or
   transcripts = CRITICAL.
3. **Shell spawn** (`apps/web/src/app/api/terminal/run/route.ts`) —
   user-controlled command string, process lifetime, output
   streaming. Review when touched.
4. **File access** — `/api/files/*` endpoints. Path sandbox
   enforcement, symlink resolution, `..` rejection.
5. **SSE endpoints** — `/api/chat`, `/api/chat/resume`,
   `/api/terminal/run`. Session-ID handling, reconnect auth.

## Attribution

Adapted from the `/cso` skill in
[github.com/garrytan/gstack](https://github.com/garrytan/gstack), by
Garry Tan, under its MIT licence. The OWASP Top 10 category list,
STRIDE matrix, severity/confidence scheme, and phased-audit structure
are ports. The Chief-Security-Officer role-catalog framing was
stripped to honour MARVIN's single-assistant rule
([ADR-0001](../../../docs/decisions/0001-single-assistant.md)); the
output remains structurally identical.
