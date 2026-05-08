# ADR-0019 — Phase 4 native BrainLiquid: shape and sub-phases

**Status:** Accepted
**Decider:** Robert Ilisei
**Date:** 2026-05-04
**Supersedes:** _none_
**Superseded by:** _none_

## Context

[ADR-0016](./0016-swift-migration.md) sketches Phase 4 as one row: port
`BrainLiquid` to MetalKit, same `PROFILES` table, same lerp logic, same
`pulseResize` signal — but with the render running on the GPU off the
main thread. Phases 1–3 are now shipped on `feat/swift-migration`
(commits `phase 1d.<n>`, `phase 2x.<n>`, `phase 3x.<n>`).

`BrainLiquid` is the most complex single component MARVIN ships:
[`apps/web/src/components/brain/brain-liquid.tsx`](../../apps/web/src/components/brain/brain-liquid.tsx)
is 900 lines of carefully-tuned canvas physics + rendering. It runs a
particle system of up to 12 000 particles, 8 attractors, 3D curl-noise
flow, density grid, leader logic, synapse pulses, theme-aware nebula
palette, and 700 ms cubic-eased state transitions across five
behavioural profiles (idle / thinking / tool / writing / error).

Phase 4 is the heaviest single lift in ADR-0016; the row in that ADR
doesn't spell out the sub-phase order, the GPU pipeline shape, or the
"match-not-improve" parity gate against the lab standalone the design
team ships. This ADR fills the same gap [ADR-0017](./0017-phase-2-chat-native.md)
filled for Phase 2 and [ADR-0018](./0018-phase-3-files-source-control-native.md)
for Phase 3.

## Decision

### 1. The brain ports as a native MetalKit island, not as a re-skin.

The visual identity is canon. The `Brain Lab _standalone_.html` the
design team ships remains the source of truth; the Swift port is a
rendering target that consumes the same per-state profile table the
React component does, with the same five behavioural states, the same
lerp easing, the same RENDER_SCALE oversize logic, and the same
nebula palette. When the lab updates, the Swift `Profile` struct
gets re-extracted via Playwright on the standalone HTML alongside
the TypeScript `PROFILES` table — both targets stay in sync.

We do NOT redesign the visualizer for native, do NOT change the
particle counts, do NOT adopt a different palette. Visual parity
is the gate; perf is the win.

### 2. Web BrainLiquid stays visible until native parity is reached.

Same gate that governed Phase 2g (web chat hides only after native
parity) and Phase 3d (web file tree hides only after native parity):
under `[data-host-shell="swift"]` the in-WebView `<BrainLiquid>`
becomes `display: none` only when the native MTKView reaches feature
parity — five profiles render correctly, transitions lerp, theme
follows the bridge, reduced-motion accommodation honoured, and 60 fps
verified at N=12 000. Until then the WebView's `<BrainLiquid>` is the
brain the user sees in MARVIN-Swift; the native MTKView lives in a
side preview pane.

### 3. Sub-phases (each independently shippable)

The phase order minimises risk of a half-shipped renderer. 4a–4c are
zero-visual-impact (no rendered output a user sees), 4d ships a
visible-but-unbranded particle render, 4e–4f reach feature parity, 4g
flips the CSS gate, 4h is perf cleanup.

| Sub-phase | Scope | Definition of Done |
|---|---|---|
| **4a — Foundation** | `BrainProfile.swift` (Swift mirror of TS `Profile` struct + PROFILES table), `BrainState.swift` (the five-state enum + transition lerper + `easeInOutCubic`). Pure Swift, no rendering. | Compile passes; unit-style smoke (lerpProfile(idle, thinking, 0.5)) returns the same fields the TS version does. |
| **4b — CPU physics port** | `BrainSimulation.swift` — port the per-frame physics from JS to Swift: position arrays, curl-noise flow, attractor pulses, leader logic, density grid, lifecycle. Outputs an array of (x, y, z, alpha, hue, leader) per particle per frame. No rendering yet. | Stepping the simulation N times produces particle arrays with the same statistical signature (mean radius, pulse cadence, leader distribution) as the JS version. |
| **4c — MTKView mount** | `BrainMetalView.swift` — `NSViewRepresentable` wrapping `MTKView`. Empty render pass (clear color matching the brain backdrop). Lives in a side preview window during 4c so the main brain stays untouched. | The MTKView mounts inside a "Brain (preview)" Window scene, draws a clear color at 60 fps, doesn't fight the WebView for compositor resources. |
| **4d — GPU particle render (CPU-driven)** | Vertex + fragment shaders for instanced particle quads. Vertex projects the (x, y, z) position with the same perspective formula the JS uses (`persp = 1 + zr/(R*3)`); fragment paints with theme-tinted nebula colour + per-particle alpha. Trail decay via accumulation texture. CPU still runs the physics (4b's port). | Five profiles render visibly correct particle clouds in the preview window; trails decay; theme switches change the palette. |
| **4e — Compute-shader physics** | Move the per-frame physics from CPU to a Metal compute kernel. Particle position arrays live in a buffer; the kernel reads + writes them per frame. Curl noise becomes a procedural function on the GPU; attractors travel as a small uniform array. | 60 fps with N=12 000 verified on the user's machine via a frame-time HUD. CPU usage drops to ≤5% on the main thread during a `thinking`-state run (was ≥30% in the JS equivalent). |
| **4f — Theme + transition + resize** | Wire `bridge.preferredColorScheme` (light/dark) to the palette uniform. Wire `bridge.isBusy` (the same flag Phase 1d.20 added) into the `BrainState` machine for default mapping. Wire SwiftUI `GeometryReader` size changes through a `pulseResize`-equivalent throttle so dragging the HSplitView splitter doesn't fight the GPU loop. | State transitions ease over 700 ms matching the TS lerp. Theme flips re-tint instantly. Resize during a turn doesn't drop frames. |
| **4g — Hide web BrainLiquid** | Tag `<BrainLiquid>` with `data-marvin-brain`; add the CSS rule `[data-host-shell="swift"] [data-marvin-brain] { display: none }`. Promote the native MTKView from the preview window into the work-pane empty state in the main window. | Running in MARVIN-Swift, the work-pane brain is the native MTKView, and the WebView's `<BrainLiquid>` is suppressed. The "WORK PANE" empty-state hint stays visible alongside. Web / Tauri builds keep the WebView brain. |
| **4h — Perf cleanup** | `prefers-reduced-motion` accommodation (Reduce Motion → 10 fps frame-gate, matching the TS version). Idle frame-throttle (when `state == .idle`, render at ~30 fps to save battery). Visibility gate (when the window is occluded / minimised, pause the kernel). | `pmset -g log` shows MARVIN-Swift in idle drops to ~10% the CPU it consumed before the throttle. Reduce Motion in System Settings → reduced cadence visible. |

### 4. Out of scope for Phase 4

These are real but later (or deliberately not native at all):

- **Lab-driven ADR re-extraction.** The procedure for refreshing the
  PROFILES table from the standalone (Playwright drive, read each
  range slider) is unchanged from the TS version. We don't introduce
  a Swift-side lab; the standalone HTML stays the design source.
- **Audio-reactive brain.** Discussed in design, not part of the lab
  standalone, not part of Phase 4.
- **Per-particle data binding from chat.** The brain's job is "MARVIN's
  felt state at a glance" — wiring per-token / per-tool data into
  particle behaviour is a v1.4+ idea, separate ADR.
- **Multiple brain instances.** Phase 4 ships one MTKView in the work-
  pane. The web build today renders a small `<BrainLiquid>` on the
  landing hero; the native shell doesn't have a corresponding hero
  surface, so the second instance question doesn't apply.

### 5. Non-decisions deliberately deferred

- **Metal compute kernel vs vertex-stage physics.** Default to
  compute kernel in 4e — separates physics from render and matches
  industry practice. Drop down to vertex-stage if measurement shows
  the buffer hop is the bottleneck (unlikely at N=12 000).
- **Trail strategy: accumulation texture vs ping-pong.** Single
  accumulation texture with per-frame `rgba(0,0,0, 1 - trail)`
  fillRect-equivalent in 4d (matches what the JS canvas does). If
  the destination-out blend wedges on Apple Silicon's TBDR, fall
  back to ping-pong. Decide with a profile, not folklore.
- **Particle storage: structs vs SoA.** Structure-of-arrays (one
  buffer per Float32 field) in 4b/4e to mirror the TS typed arrays.
  Switch to AoS if the GPU access pattern shows up as a bottleneck
  in 4e — also a measurement-driven decision.

## Consequences

- The migration commit history continues with `phase 4x.<n>`
  prefixes, matching the 1d / 2x / 3x shape that worked through
  Phases 1d, 2, and 3.
- Each sub-phase is independently shippable; we can stop after any
  of them (e.g. after 4d the user gets a visible native brain in a
  preview window, useful even before 4e's perf win).
- The Tauri build at `apps/desktop/` continues to render
  `<BrainLiquid>` unchanged; nothing in Phase 4 touches the Tauri
  shell or the standalone lab HTML.
- The `data-marvin-brain` attribute joins
  `data-marvin-{cost-pill,wordmark,chat-pane,file-tree}` as the
  set of web surfaces gated on host-shell.

## Scope of Done

For ADR-0019 itself (this document):

- Phase 4 sub-phase list locked above. Re-derive only via a follow-up ADR.
- Match-not-improve gate (web brain stays until parity) explicit.
- Out-of-scope §4 is the only place to look for "is X part of Phase 4?"
  — if it's not in the sub-phase table and not explicitly out-of-scope,
  the answer is "decide as it comes up, document the call in a CHANGELOG entry."
