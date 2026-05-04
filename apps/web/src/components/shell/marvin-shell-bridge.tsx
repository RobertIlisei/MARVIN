"use client";

// MarvinShellBridge — runs once on mount, detects the SwiftUI host
// shell, and posts a hello message on the bridge so the Swift side
// can confirm the channel works end-to-end.
//
// Renders nothing. Mounted at the root layout level so it runs on
// every page without needing per-page wiring. Costs one no-op
// effect when running outside the Swift shell (the standard Tauri
// build, the web-only dev loop), so always-mounted is fine.
//
// See `apps/web/src/lib/marvin-shell.ts` for the bridge contract
// and `apps/macos/MARVIN/Bridge.swift` for the Swift counterpart.

import { useEffect } from "react";
import { announceShell } from "@/lib/marvin-shell";

export function MarvinShellBridge() {
  useEffect(() => {
    announceShell();
  }, []);
  return null;
}
