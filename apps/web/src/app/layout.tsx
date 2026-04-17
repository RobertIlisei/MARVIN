import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MARVIN",
  description: "Moderately Advanced Robotic Virtual Intelligence Network",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
