import { describe, expect, it } from "vitest";

import { gitReadsTakeNoLock } from "../src/git-env";

/**
 * 2026-11-24: a merge in a project's main checkout answered
 * "fatal: Unable to write index." and never started. `git status` writes a
 * refreshed index back under `index.lock`; MARVIN runs it in the project root
 * for the session feed, and a merge, commit or checkout that began in that
 * instant was refused. Seen three times in a month on one project.
 */
describe("gitReadsTakeNoLock", () => {
  it("turns git's optional locks off for every child the sidecar spawns", () => {
    const env = {} as NodeJS.ProcessEnv;
    gitReadsTakeNoLock(env);
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("leaves a value the user set alone", () => {
    const env = { GIT_OPTIONAL_LOCKS: "1" } as unknown as NodeJS.ProcessEnv;
    gitReadsTakeNoLock(env);
    expect(env.GIT_OPTIONAL_LOCKS).toBe("1");
  });
});
