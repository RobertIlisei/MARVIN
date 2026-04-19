# ADR-0006 — Light-first theme cascade

**Status:** Accepted
**Date:** 2026-04-19
**Deciders:** @robertilisei, MARVIN

## Context

MARVIN shipped originally with a single dark theme — warm "depressed genius" amber + cream on olive-black ink. It was part of the MARVIN identity (Hitchhiker's-Guide persona, instrument-panel aesthetic).

In April 2026 we ran the MARVIN UI through Anthropic's [Claude Design](https://claude.ai/design) tool. The handoff bundle (`DARK_THEME_HANDOFF.md`) returned a two-theme spec:

- **Light** as the primary / default — warm off-white (oklch 0.985 0.003 80), monochrome-ink accent, Apple-Intelligence iridescent halo seeds.
- **Dark** as the override — pure black bg, icy-blue accent (oklch 0.82 0.10 230), dark slate-blue elevated surfaces, cool halo seeds.

The handoff's cascade structure was explicit: `:root` carries the light tokens; `[data-theme="dark"]` on `<html>` layers dark on top.

A first pass implemented the flip wrong — light as an overlay on the original amber dark theme. The user correctly pushed back: "you did not implement the dark theme you were supposed to." The second pass flipped the cascade to match the handoff.

## Decision

**`:root` = handoff light palette (default). `[data-theme="dark"]` = handoff icy-blue-on-black dark palette.**

Implementation:

- [`apps/web/src/app/globals.css`](../../../apps/web/src/app/globals.css):
  - `@theme` and `:root` hold the light OKLCH values (warm paper, ink). Tailwind generates utilities against these names.
  - `[data-theme="dark"]` re-assigns every `--color-*` to the icy-blue dark equivalent. Also swaps `color-scheme`, halo seeds, shadow-panel, display-tint.
  - Decorations that were amber-only (body::before radials, html::after grain, hero-orbit rings, constellation, title-glow) were either parameterized via CSS vars (halo seeds) or given explicit `[data-theme="dark"]` overrides.
- **Bootstrap script** in [`layout.tsx`](../../../apps/web/src/app/layout.tsx) reads `localStorage.marvin-theme` pre-paint. Sets `data-theme="dark"` if saved='dark' or `prefers-color-scheme: dark`. Absent attribute = light.
- **Toggle component**: [`theme-toggle.tsx`](../../../apps/web/src/components/settings/theme-toggle.tsx) — ☾ shown while in light (click to dark), ☀ shown while in dark (click to light). Persists to `localStorage.marvin-theme`.
- **`useTheme()` hook**: [`use-theme.ts`](../../../apps/web/src/components/settings/use-theme.ts) — MutationObserver on `<html data-theme>`, used by Monaco and xterm for palette swaps that live outside the CSS-var cascade.
- **`<html suppressHydrationWarning>`** in `layout.tsx` — the bootstrap script sets the attribute before React hydrates; without suppression, React warns.

## Consequences

**Positive:**

- Faithful to the Claude Design handoff's cascade contract. A future design iteration that edits `DARK_THEME_HANDOFF.md` maps cleanly onto MARVIN.
- Light becomes the approachable default for users on system-light OS settings. The amber/dark identity is preserved for users who prefer dark (majority of devs, empirically).
- Monochrome-ink accent in light is more legible than muted amber would be. The handoff's call.
- Cascade structure is conventional: `:root` is the baseline, data-attrs are overrides. Matches how the broader CSS ecosystem expects theming to work (next-themes, shadcn, Tailwind's dark mode).

**Negative:**

- Migration cost — every previously-written CSS rule had to be audited for hardcoded color literals. The second pass scoped overrides to `[data-theme="dark"]` for hero-orbit / constellation / title-glow decorations, but a long tail of component-level Tailwind classes (`bg-black/40`, etc.) remains.
- MARVIN's original dark amber identity is gone. Users who preferred the sulphur mood will miss it. Mitigation: the dark theme that replaced it (icy-blue-on-black) is its own distinct identity, and arguably more coherent with the brain's particle palette.
- Brain component (`brain-liquid.tsx`) has theme-aware painting built-in, but the older SVG-based `marvin-brain.tsx` still has 6 hardcoded cyan rgba values. In practice these read as "iridescent accent reserved for the brain" in light mode, which the handoff explicitly allows. Still, an inconsistency.

## Alternatives considered

### Keep amber dark as `:root`, layer light on top

*What it is:* The structure the first pass shipped — `:root` carries amber dark, `[data-theme="light"]` overrides to paper/ink.

*Why plausible:* Minimizes diff from MARVIN's original identity. Users who never opt into light see no change.

*Why rejected:* Violates the handoff's contract. The handoff explicitly said "light is :root; dark is the override" and documented the cascade that way. Inverting it would make future design iterations harder to apply, and the amber vs handoff-dark are different aesthetics — this isn't "light amber vs dark amber," it's "paper+ink vs black+icy-blue." The right frame was always a full replacement, not an overlay.

### Ship both amber and icy-blue as separate `data-theme` values

*What it is:* `[data-theme="amber-dark"]`, `[data-theme="icy-dark"]`, `[data-theme="light"]` — three options.

*Why plausible:* User preference.

*Why rejected:* Two themes are a design system; three is a palette. Every new option multiplies the audit surface. If MARVIN ever does want a retro-amber mode, it'd be a single theme toggle in the settings, not a cascade-level entry. Not v1.

### Use Tailwind's built-in `dark:` variants

*What it is:* Instead of CSS-var cascade, use Tailwind's `class="dark"` convention and `dark:bg-black` utilities everywhere.

*Why plausible:* Canonical Tailwind pattern.

*Why rejected:*

- Requires touching every component that uses a color. The CSS-var approach touches one file (`globals.css`).
- Doesn't compose with libraries that live outside Tailwind's class system (Monaco, xterm). Those need explicit palette swaps regardless.
- The handoff itself was written against CSS vars, not Tailwind utilities. Porting to `dark:` variants would require translating every token twice.

## Verification

- `curl http://localhost:3030/` returns the light-theme default CSS.
- Toggling to dark via the `☀/☾` pill flips `<html data-theme="dark">` and the CSS cascade follows.
- Reload preserves the choice (localStorage).
- System-dark users see dark on first visit, system-light see light, without a flash in either case (bootstrap script runs pre-paint).
- Monaco diffs register both `marvin-light` and `marvin-dark` themes; `setTheme` is called with the correct name on theme change.
- xterm swaps between `XTERM_THEME_LIGHT` and `XTERM_THEME_DARK` without tearing down the PTY.

## Related

- [`globals.css`](../../../apps/web/src/app/globals.css) — the cascade source.
- [`theme-toggle.tsx`](../../../apps/web/src/components/settings/theme-toggle.tsx)
- [`use-theme.ts`](../../../apps/web/src/components/settings/use-theme.ts)
- `DARK_THEME_HANDOFF.md` from Claude Design — the spec this port implements (see PLAN.md changelog for 2026-04-19).
