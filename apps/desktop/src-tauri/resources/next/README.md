# Next.js standalone bundle

This directory is **empty by default**. The real Next.js standalone
output is staged here by `apps/desktop/scripts/bundle-resources.sh`
before `pnpm desktop:build` packages the `.app`:

```bash
# From the repo root
apps/desktop/scripts/bundle-resources.sh
```

That runs `pnpm --filter @marvin/web build` (producing
`apps/web/.next/standalone/`) and copies it here with the static +
public assets reattached.

The `.gitkeep` and this README are the only tracked files — the
bundle is ~40–80 MB and rebuilt per release. See
[ADR-0011](../../../../../docs/decisions/0011-sidecar-node-bundling.md).
