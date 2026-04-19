import type { Metadata } from "next";
import { Geist, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Body UI — kept sans-serif for pane density. Geist is fine for buttons,
// labels, chat text; it's the display + mono that were doing the heavy
// "generic AI tool" lifting and needed replacement.
const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

// Display — `Instrument Serif`. Editorial, slightly literary, matches
// MARVIN's Hitchhiker's-Guide persona ("brain the size of a planet…").
// Used for the wordmark, hero headings, and any `.font-display` block.
const instrumentSerif = Instrument_Serif({
  variable: "--font-display",
  weight: ["400"],
  style: ["normal", "italic"],
  subsets: ["latin"],
  display: "swap",
});

// Mono — `JetBrains Mono`. More distinctive than the default Geist Mono;
// reads well at small sizes in the terminal + file viewer.
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${instrumentSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
