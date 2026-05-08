"use client";

// ADR-0021 M5: WebView removed. MarvinShellBridge was the JS↔Swift
// WKScriptMessageHandler wiring — no longer needed. Kept as a no-op
// stub so import sites don't need to be hunted down.

export function MarvinShellBridge() {
  return null;
}
