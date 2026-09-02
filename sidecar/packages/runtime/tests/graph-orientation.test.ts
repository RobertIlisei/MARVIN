import { describe, expect, it } from "vitest";

import { buildOrientationQuery, formatOrientation } from "../src/graph-orientation";

describe("graph pre-orientation query", () => {
  it("keeps the task's content words and drops filler, commands, wakeups and attachments", () => {
    expect(buildOrientationQuery("fix the login flow in AuthService so the session token refreshes")).toBe(
      "login flow authservice session token refreshes",
    );
    expect(buildOrientationQuery("continue")).toBeNull();
    expect(buildOrientationQuery("please proceed now")).toBeNull();
    expect(buildOrientationQuery("/groom")).toBeNull();
    expect(buildOrientationQuery("[scheduled wakeup — poll the pipeline]")).toBeNull();
    expect(buildOrientationQuery("@/Users/x/att.png  look at this")).toBeNull();
    expect(buildOrientationQuery("Why does `graph_search` return nothing for DiffGutterBar and STTextView?")).toBe(
      "return nothing diffgutterbar sttextview",
    );
  });

  it("caps at twelve unique terms", () => {
    const q = buildOrientationQuery(Array.from({ length: 30 }, (_, i) => `symbol${i}`).join(" "));
    expect(q?.split(" ")).toHaveLength(12);
  });
});

describe("graph pre-orientation block", () => {
  it("renders the top hits with file and degree, and says the tools are loaded", () => {
    const block = formatOrientation("login token", [
      { id: "a", label: "AuthService", sourceFile: "src/auth.ts", degree: 12, community: 1 },
      { id: "b", label: "refreshToken()", sourceFile: null, degree: 1, community: 1 },
    ]);
    expect(block).toContain("**AuthService** — `src/auth.ts` (12 edges)");
    expect(block).toContain("**refreshToken()** (1 edge)");
    expect(block).toContain("counts as your first graph call");
    expect(block).toContain("no ToolSearch");
  });

  it("is null with no hits", () => {
    expect(formatOrientation("x", [])).toBeNull();
  });
});
