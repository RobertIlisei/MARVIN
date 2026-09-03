#!/usr/bin/env node
// Render docs/whitepaper/*.md to PDF with the Playwright Chromium already on
// this machine (no install step): markdown via marked, ```mermaid fences as
// inline SVG. Usage: node scripts/whitepaper-pdf.mjs <in.md> <out.pdf>
// Regenerate both after any whitepaper edit:
//   node scripts/whitepaper-pdf.mjs docs/whitepaper/WHITEPAPER.md docs/whitepaper/WHITEPAPER.pdf
//   node scripts/whitepaper-pdf.mjs docs/whitepaper/TECHNICAL-REFERENCE.md docs/whitepaper/TECHNICAL-REFERENCE.pdf
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function newest(dir, prefix) {
  if (!fs.existsSync(dir)) return null;
  const hits = fs.readdirSync(dir).filter((d) => d.startsWith(prefix)).sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)));
  return hits.length ? path.join(dir, hits[0]) : null;
}
// playwright: the sidecar's, else the newest one npx cached.
let pwDir = null;
try { pwDir = path.dirname(require.resolve('playwright/package.json', { paths: [path.resolve('sidecar')] })); } catch {}
if (!pwDir) {
  const npx = path.join(os.homedir(), '.npm', '_npx');
  const cands = fs.existsSync(npx) ? fs.readdirSync(npx).map((h) => path.join(npx, h, 'node_modules', 'playwright')).filter((p) => fs.existsSync(path.join(p, 'package.json'))) : [];
  cands.sort((a, b) => require(path.join(b, 'package.json')).version.localeCompare(require(path.join(a, 'package.json')).version, undefined, { numeric: true }));
  pwDir = cands[0] ?? null;
}
if (!pwDir) { console.error('playwright not found; run: npx playwright install chromium'); process.exit(1); }
const { chromium } = await import(path.join(pwDir, 'index.mjs'));
const chromeDir = newest(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), 'chromium-');
const exeCands = chromeDir ? [path.join(chromeDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'), path.join(chromeDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')] : [];
const executablePath = exeCands.find((p) => fs.existsSync(p));
const [,, mdPath, pdfPath] = process.argv;
const md = fs.readFileSync(mdPath, 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
<style>
 body{font:11pt/1.45 -apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif;color:#111;max-width:100%;margin:0;padding:0}
 h1{font-size:22pt;margin:0 0 6pt} h2{font-size:15pt;margin:18pt 0 6pt;page-break-after:avoid} h3{font-size:12.5pt;margin:14pt 0 4pt;page-break-after:avoid}
 p,li{orphans:3;widows:3} code{font:9.5pt ui-monospace,Menlo,monospace;background:#f3f3f3;padding:0 3px;border-radius:3px}
 pre{background:#f6f6f6;padding:8pt;border-radius:4px;font-size:9pt;white-space:pre-wrap;word-break:break-word;page-break-inside:avoid}
 pre code{background:none;padding:0;font-size:9pt}
 table{border-collapse:collapse;font-size:9.5pt;margin:8pt 0;width:100%;page-break-inside:avoid} th,td{border:1px solid #ccc;padding:3pt 5pt;vertical-align:top;text-align:left}
 blockquote{border-left:3px solid #bbb;margin:8pt 0;padding:2pt 10pt;color:#333}
 hr{border:0;border-top:1px solid #ddd;margin:14pt 0}
 .mermaid{page-break-inside:avoid;margin:10pt 0;text-align:center} .mermaid svg{max-width:100%;height:auto}
 em{color:#222} a{color:#1a4fa3;text-decoration:none}
</style></head><body><div id="out"></div>
<script>
 const src = ${JSON.stringify(md)};
 const renderer = new marked.Renderer();
 const origCode = renderer.code.bind(renderer);
 renderer.code = (tok) => tok.lang === 'mermaid' ? '<pre class="mermaid">' + tok.text.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</pre>' : origCode(tok);
 document.getElementById('out').innerHTML = marked.parse(src, { renderer, gfm: true });
 mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
 mermaid.run({ querySelector: '.mermaid' }).then(() => { window.__done = true; }).catch(e => { window.__done = 'err:' + e.message; });
</script></body></html>`;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__done !== undefined, null, { timeout: 60000 });
const done = await page.evaluate(() => window.__done);
const nSvg = await page.evaluate(() => document.querySelectorAll('.mermaid svg').length);
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' }, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:8pt;color:#888;width:100%;text-align:center"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
await browser.close();
console.log(`${pdfPath}: mermaid=${done} svgs=${nSvg}`);
