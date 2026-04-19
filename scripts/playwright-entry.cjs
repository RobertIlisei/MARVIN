// Resolve playwright from pnpm's virtual store. `playwright` is a
// transitive dep of @playwright/mcp; pnpm doesn't hoist transitive deps
// to the workspace root, so we walk `.pnpm` to find the real package.
const fs = require("node:fs");
const path = require("node:path");

const pnpmRoot = path.join(__dirname, "..", "node_modules", ".pnpm");
const dir = fs
  .readdirSync(pnpmRoot)
  .find((name) => name.startsWith("playwright@"));

if (!dir) {
  throw new Error(
    "playwright not found in node_modules/.pnpm — run `pnpm install` first",
  );
}

module.exports = require(
  path.join(pnpmRoot, dir, "node_modules", "playwright"),
);
