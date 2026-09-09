// metered-ci — the classifier behind the "this spends CI minutes" confirm
// (ADR-0109).
//
// Both directions matter and for different reasons. A miss means the gate
// silently does not exist, which is the failure ADR-0079 found in five other
// guards. A false positive on `git push` would be worse than useless: pushing
// is free on a pipeline-gated project and is how work is kept safe, so a
// confirm there would train the user to click through the one that matters.

import { describe, expect, it } from "vitest";

import { classifyMeteredCiRisk, describeMeteredCiRisk, meteredCiAlternative } from "../src/metered-ci";

describe("classifyMeteredCiRisk", () => {
  it("catches opening a request on both forges", () => {
    expect(classifyMeteredCiRisk("glab mr create --fill")).toMatchObject({ risk: "opens-request" });
    expect(classifyMeteredCiRisk("gh pr create --base main")).toMatchObject({ risk: "opens-request" });
    expect(classifyMeteredCiRisk("glab mr new")).toMatchObject({ risk: "opens-request" });
  });

  it("catches merging a request", () => {
    expect(classifyMeteredCiRisk("glab mr merge 42")).toMatchObject({ risk: "merges-request" });
    expect(classifyMeteredCiRisk("gh pr merge --squash")).toMatchObject({ risk: "merges-request" });
  });

  it("catches starting a pipeline by hand", () => {
    expect(classifyMeteredCiRisk("glab ci run")).toMatchObject({ risk: "runs-pipeline" });
    expect(classifyMeteredCiRisk("glab pipeline retry 99")).toMatchObject({ risk: "runs-pipeline" });
    expect(classifyMeteredCiRisk("gh workflow run smoke.yml")).toMatchObject({ risk: "runs-pipeline" });
    expect(classifyMeteredCiRisk("gh run rerun 12345")).toMatchObject({ risk: "runs-pipeline" });
  });

  it("catches the push options that open an MR or ask for a pipeline", () => {
    expect(
      classifyMeteredCiRisk("git push -o merge_request.create -o merge_request.target=main origin HEAD"),
    ).toMatchObject({ risk: "opens-request" });
    expect(classifyMeteredCiRisk("git push -o ci.pipeline origin HEAD")).toMatchObject({
      risk: "runs-pipeline",
    });
  });

  it("leaves a plain push alone — it starts no pipeline and it is how work is kept safe", () => {
    expect(classifyMeteredCiRisk("git push")).toBeNull();
    expect(classifyMeteredCiRisk("git push origin marvin/tab/thing")).toBeNull();
    expect(classifyMeteredCiRisk("git push --set-upstream origin HEAD")).toBeNull();
    expect(classifyMeteredCiRisk("git push --force-with-lease")).toBeNull();
  });

  it("leaves local git alone", () => {
    for (const cmd of ["git commit -m x", "git merge feature", "git status", "git log --oneline"]) {
      expect(classifyMeteredCiRisk(cmd)).toBeNull();
    }
  });

  it("leaves reads on the forge CLIs alone", () => {
    for (const cmd of [
      "glab mr list",
      "glab mr view 42",
      "glab mr diff 42",
      "gh pr view --json state",
      "gh pr checkout 7",
      "glab ci status",
      "glab pipeline list",
      "gh run view 1 --log",
      "gh workflow list",
      "glab mr create --help",
    ]) {
      expect(classifyMeteredCiRisk(cmd), cmd).toBeNull();
    }
  });

  it("ignores anything with none of the three tool names", () => {
    expect(classifyMeteredCiRisk("npm run build")).toBeNull();
    expect(classifyMeteredCiRisk("")).toBeNull();
    expect(classifyMeteredCiRisk("   ")).toBeNull();
  });

  it("names the verb it matched, for the confirm card", () => {
    expect(classifyMeteredCiRisk("glab mr create")?.verb).toBe("glab mr create");
    expect(classifyMeteredCiRisk("gh pr merge 3")?.verb).toBe("gh pr merge");
  });

  it("every risk class has a description and advice", () => {
    for (const risk of ["opens-request", "merges-request", "runs-pipeline"] as const) {
      expect(describeMeteredCiRisk(risk).length).toBeGreaterThan(10);
      expect(meteredCiAlternative(risk).length).toBeGreaterThan(10);
    }
    // Opening a request is the one with a genuinely free alternative, so its
    // advice names it.
    expect(meteredCiAlternative("opens-request")).toMatch(/Merge all ready/);
  });
});
