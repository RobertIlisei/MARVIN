const fs = require('fs');
const content = fs.readFileSync('/Users/valid/Library/Logs/DiagnosticReports/MARVIN-2026-08-28-135113.ips', 'utf8');
const lines = content.split('\n');
for (const line of lines) {
  if (!line.trim() || !line.startsWith('{')) continue;
  try {
    const json = JSON.parse(line);
    if (json.threads) {
      const faulting = json.threads.find(t => t.id === json.faultingThread || t.triggered);
      if (faulting) {
        console.log("Faulting thread frames:");
        for (const f of faulting.frames) {
          const img = json.usedImages[f.imageIndex];
          console.log(`- ${img.name}: offset ${f.imageOffset}, symbol: ${f.symbol || '?'}`);
        }
      }
    }
  } catch (e) {}
}
