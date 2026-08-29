# ADR-0089 — Trust the vault server, keep consent on the one tool that writes to the user's repo

- **Status:** Accepted
- **Date:** 2026-08-30
- **Related:** [ADR-0065](./0065-obsidian-vault-project-as-vault.md) (the vault integration), [ADR-0053](./0053-plugins-as-local-plugin-loader.md) (the MCP trust inversion)

## Context

Found while regression-testing [ADR-0088](./0088-rename-canary-for-the-dispatch-tool.md):
`mcp__marvin-obsidian__` is registered as an in-process server in
`sdk-runner.ts` but was **absent from `TRUSTED_INPROCESS_MCP_PREFIXES`**. The
list's own comment says "keep in lockstep with the `mcpServers` MARVIN
registers in `sdk-runner.ts`", so this is a lockstep failure: every vault call
was confirm-gated as though it came from an untrusted third-party plugin.

Adding the prefix is not the whole answer. The list is documented as trusted
**read-only** servers, and while `marvin-memory` and `marvin-backlog` do write,
they write only under `.marvin/` — a directory MARVIN owns. `obsidian_init`
writes `.obsidian/` into the **user's repository**, and ADR-0065 is explicit:

> Writing config into someone's repository as a side effect of a turn is not
> ours to do, and `personality.ts` says so as a MUST NOT.

A blanket trust entry would silently convert that documented opt-in into an
auto-allow — fixing a papercut by deleting a consent gate.

## Decision

Add `mcp__marvin-obsidian__` to the trusted prefixes, **and** introduce
`TRUSTED_MCP_CONFIRM_EXCEPTIONS` holding exactly one entry:
`mcp__marvin-obsidian__obsidian_init`.

- `obsidian_status` — read-only inspection — takes the fast path, as the other
  trusted read tools do.
- `obsidian_init` — writes `.obsidian/`, `MARVIN.md` and the note families —
  still resolves to `confirm`, preserving ADR-0065's opt-in.

The exception set exists because "trusted server" and "every tool on it is
safe to auto-run" are different claims, and the code previously had no way to
say the first without implying the second.

## Consequences

- Vault status checks stop prompting; the one destructive-ish call still does.
- A future in-process server with a mixed tool set has somewhere to express it.
- The list's lockstep comment is now load-bearing rather than aspirational —
  worth a test if a fifth server lands.

## Scope of Done

- [x] `mcp__marvin-obsidian__` trusted; `obsidian_init` excepted to `confirm`
- [x] The other four servers and all external servers unchanged, test-pinned
- [ ] Not in scope: a lockstep test between `sdk-runner`'s `mcpServers` and the
      prefix list; reading the user's own notes (ADR-0065 forbids it)
