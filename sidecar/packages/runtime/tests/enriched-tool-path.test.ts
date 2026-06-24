import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { enrichedToolPath } from "../src/sdk-runner";

// ADR-0045 follow-up: a Finder-launched macOS app inherits the minimal launchd
// PATH (/usr/bin:/bin:/usr/sbin:/sbin), which omits Homebrew where the user's
// node/npx live — so the SDK's bare `npx @playwright/mcp@latest` spawn ENOENTs
// and the browser tools never register. enrichedToolPath() prepends the node
// locations so the spawn resolves. These pin that contract.
describe("enrichedToolPath (ADR-0045 follow-up — GUI-launch PATH fix)", () => {
  it("prepends Homebrew + /usr/local to a minimal launchd PATH", () => {
    const minimal = "/usr/bin:/bin:/usr/sbin:/sbin";
    const out = enrichedToolPath(minimal).split(":");
    expect(out).toContain("/opt/homebrew/bin");
    expect(out).toContain("/usr/local/bin");
    // Homebrew must come BEFORE the system dirs so its npx wins resolution.
    expect(out.indexOf("/opt/homebrew/bin")).toBeLessThan(out.indexOf("/usr/bin"));
  });

  it("includes the running node's own bin dir (covers a bundled node)", () => {
    expect(enrichedToolPath("/usr/bin").split(":")).toContain(dirname(process.execPath));
  });

  it("preserves existing PATH entries and de-duplicates", () => {
    // /opt/homebrew/bin already present must not appear twice.
    const out = enrichedToolPath("/opt/homebrew/bin:/usr/bin").split(":");
    expect(out.filter((p) => p === "/opt/homebrew/bin")).toHaveLength(1);
    expect(out).toContain("/usr/bin");
  });

  it("drops empty segments", () => {
    expect(enrichedToolPath("::/usr/bin:").split(":")).not.toContain("");
  });
});
