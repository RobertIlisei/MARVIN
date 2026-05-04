"use client";

// MarvinShellBridge — runs on mount, detects the SwiftUI host shell,
// and wires the JS↔Swift bridge:
//   • Posts a hello message + stamps <html data-host-shell="swift">
//     so CSS can adapt and the Swift side knows the channel works.
//   • Mirrors document.title to the native NSWindow title (Phase 1d)
//     by posting the initial value and a fresh message every time
//     <title> changes. Watches via MutationObserver — the React
//     side already mutates document.title for the (N) confirm-
//     pending badge, so no React-side coordination is needed.
//
// Renders nothing. Mounted at the root layout level so it runs on
// every page without needing per-page wiring. Costs one no-op
// effect when running outside the Swift shell (the standard Tauri
// build, the web-only dev loop), so always-mounted is fine.
//
// See `apps/web/src/lib/marvin-shell.ts` for the bridge contract
// and `apps/macos/MARVIN/Bridge.swift` for the Swift counterpart.

import { useEffect } from "react";
import { announceShell, announceTitle, isSwiftShell } from "@/lib/marvin-shell";

export function MarvinShellBridge() {
  useEffect(() => {
    announceShell();
    if (!isSwiftShell()) return;

    // Initial title — fires before any subsequent change so the
    // native title bar isn't briefly stuck on "MARVIN" while the
    // React app boots and first sets document.title.
    announceTitle(document.title);

    const titleEl = document.querySelector("title");
    if (!titleEl) return;
    const observer = new MutationObserver(() => {
      announceTitle(document.title);
    });
    // childList catches text-node replacements; characterData on the
    // child catches text-content edits. Subtree covers both cases.
    observer.observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);
  return null;
}
