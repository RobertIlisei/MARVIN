import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// `playwright` is a transitive dep via @playwright/mcp in packages/runtime;
// pnpm doesn't hoist it to the workspace root. The tiny CJS entry next to
// this file resolves into packages/runtime/node_modules/playwright for us.
const { chromium } = require("./playwright-entry.cjs");

const BASE = "http://localhost:3030";

async function shoot(themeName, mode) {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();

  // Set theme via localStorage before first paint.
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("marvin-theme", t);
    } catch (_) {}
  }, mode);

  await page.goto(BASE, { waitUntil: "networkidle" });
  // Give the brain canvas a moment to render a couple frames.
  await page.waitForTimeout(2500);

  const out = `/tmp/marvin-${themeName}.png`;
  await page.screenshot({ path: out, fullPage: false });
  console.log(`wrote ${out}`);
  await browser.close();
}

await shoot("light", "light");
await shoot("dark", "dark");
