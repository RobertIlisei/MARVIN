import type { Metadata } from "next";
import { Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Body UI — **system stack first** (see globals.css `--font-sans`). On
// macOS this resolves to SF Pro / `-apple-system`, which is what makes
// MARVIN look native in the Tauri window. Dropping Geist from the
// loader (A1 polish pass) also eliminates one Google Fonts network
// request at first paint — the old Geist import added ~60–90 ms
// render delay on a warm cache, more on cold.

// Display — `Instrument Serif`. Editorial, matches MARVIN's
// Hitchhiker's-Guide persona ("brain the size of a planet…"). Used
// for the wordmark + hero headings only.
const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  weight: ["400"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
});

// Mono — `JetBrains Mono`. More distinctive than the default system
// mono; reads well at small sizes in the terminal + file viewer.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "MARVIN",
  description:
    "Moderately Advanced Robotic Virtual Intelligence Network — pair-programming AI.",
};

// Blocking script that sets `<html data-theme>` before first paint.
// Matches DARK_THEME_HANDOFF.md: light is the baseline, `data-theme="dark"`
// is the opt-in attribute. Reads `localStorage.marvin-theme` first
// (user's explicit pick wins); falls back to `prefers-color-scheme: dark`
// so a system-dark visitor doesn't get flashed with paper-white.
const THEME_BOOTSTRAP = `
try {
  var saved = localStorage.getItem('marvin-theme');
  var wantDark =
    saved === 'dark' ||
    (saved !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (wantDark) document.documentElement.setAttribute('data-theme', 'dark');
} catch (_) {}
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${instrumentSerif.variable} ${jetbrainsMono.variable}`}
      // Bootstrap script (below) sets `data-theme="dark"` before React
      // hydrates when the user's saved pref or system preference asks
      // for dark. The SSR output has no such attribute, so React would
      // otherwise warn about the mismatch. Suppressing is the canonical
      // next-themes-style escape hatch — the warning only applies to
      // <html>'s own attributes, not its descendants.
      suppressHydrationWarning
    >
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: pre-hydration theme bootstrap — must run inline before React paints */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
