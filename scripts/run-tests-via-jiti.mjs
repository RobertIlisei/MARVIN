#!/usr/bin/env node
/**
 * Vitest-shape smoke runner using jiti.
 *
 * Vitest 4 in this Cowork sandbox can't run because rolldown's
 * linux-arm64 native binary isn't installed (the user's host is
 * darwin-arm64; pnpm install on macOS doesn't fetch the linux
 * binary). This script is a fallback that loads the security-critical
 * test files via jiti, registers a Vitest-shaped global describe / it
 * / expect, and runs every assertion.
 *
 * Not a full Vitest replacement — no watch mode, no parallelism, no
 * matchers beyond the small set the in-tree tests use. Enough to
 * verify the regex / policy / sandbox / argv-guards logic still
 * matches its pinned cases after each round of audit fixes.
 *
 * Usage from the sandbox: `node scripts/run-tests-via-jiti.mjs`.
 * Locally on macOS, the user just runs `pnpm test`.
 */

import { createJiti } from "/sessions/wizardly-optimistic-davinci/mnt/marvin/node_modules/.pnpm/jiti@2.6.1/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, "..");

// ----- Vitest-shaped harness ----------------------------------------------

const ctx = {
  currentSuite: [],
  beforeEachStack: [],
  afterEachStack: [],
  failed: [],
  passed: 0,
  total: 0,
};

function describe(name, fn) {
  ctx.currentSuite.push(name);
  ctx.beforeEachStack.push([]);
  ctx.afterEachStack.push([]);
  try {
    fn();
  } finally {
    ctx.currentSuite.pop();
    ctx.beforeEachStack.pop();
    ctx.afterEachStack.pop();
  }
}

async function it(name, fn) {
  const path = [...ctx.currentSuite, name].join(" › ");
  ctx.total++;
  try {
    for (const stack of ctx.beforeEachStack) for (const cb of stack) await cb();
    await fn();
    for (const stack of ctx.afterEachStack) for (const cb of stack) await cb();
    ctx.passed++;
  } catch (err) {
    ctx.failed.push({ path, error: err });
    // run afterEach even on failure so file state cleans up
    for (const stack of ctx.afterEachStack) {
      for (const cb of stack) {
        try { await cb(); } catch (_) { /* ignore */ }
      }
    }
  }
}

function beforeEach(fn) {
  const stack = ctx.beforeEachStack[ctx.beforeEachStack.length - 1];
  if (stack) stack.push(fn);
}

function afterEach(fn) {
  const stack = ctx.afterEachStack[ctx.afterEachStack.length - 1];
  if (stack) stack.push(fn);
}

class AssertionError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "AssertionError";
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

function describeContains(haystack, needle) {
  if (typeof haystack === "string") return haystack.includes(needle);
  if (Array.isArray(haystack)) {
    return haystack.some((item) => deepEqual(item, needle));
  }
  if (haystack instanceof Set) return haystack.has(needle);
  return false;
}

function expect(actual) {
  const api = {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} === ${JSON.stringify(expected)}`,
        );
      }
    },
    toEqual(expected) {
      if (!deepEqual(actual, expected)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} ≈ ${JSON.stringify(expected)}`,
        );
      }
    },
    toBeTruthy() {
      if (!actual)
        throw new AssertionError(`expected ${JSON.stringify(actual)} to be truthy`);
    },
    toBeFalsy() {
      if (actual)
        throw new AssertionError(`expected ${JSON.stringify(actual)} to be falsy`);
    },
    toBeNull() {
      if (actual !== null)
        throw new AssertionError(`expected ${JSON.stringify(actual)} to be null`);
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} to be undefined`,
        );
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new AssertionError("expected value to be defined, got undefined");
      }
    },
    toContain(substr) {
      if (!describeContains(actual, substr)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} to contain ${JSON.stringify(substr)}`,
        );
      }
    },
    toMatch(re) {
      const r = re instanceof RegExp ? re : new RegExp(String(re));
      if (typeof actual !== "string" || !r.test(actual)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} to match ${r}`,
        );
      }
    },
    toHaveLength(n) {
      const len =
        actual && typeof actual.length === "number" ? actual.length : NaN;
      if (len !== n) {
        throw new AssertionError(
          `expected length ${len} to be ${n} (value ${JSON.stringify(actual)})`,
        );
      }
    },
    toBeGreaterThan(n) {
      if (!(typeof actual === "number" && actual > n)) {
        throw new AssertionError(`expected ${actual} > ${n}`);
      }
    },
    toBeLessThan(n) {
      if (!(typeof actual === "number" && actual < n)) {
        throw new AssertionError(`expected ${actual} < ${n}`);
      }
    },
    toBeGreaterThanOrEqual(n) {
      if (!(typeof actual === "number" && actual >= n)) {
        throw new AssertionError(`expected ${actual} >= ${n}`);
      }
    },
    toThrow(expected) {
      if (typeof actual !== "function") {
        throw new AssertionError("toThrow needs a function");
      }
      let threw = false;
      let caught;
      try {
        actual();
      } catch (err) {
        threw = true;
        caught = err;
      }
      if (!threw) throw new AssertionError("expected function to throw");
      if (expected && expected instanceof RegExp) {
        if (!expected.test(String(caught?.message ?? caught))) {
          throw new AssertionError(
            `expected throw to match ${expected}, got ${caught?.message ?? caught}`,
          );
        }
      }
    },
    toStrictEqual(expected) {
      if (!deepEqual(actual, expected)) {
        throw new AssertionError(
          `expected strict ${JSON.stringify(actual)} ≈ ${JSON.stringify(expected)}`,
        );
      }
    },
  };
  api.not = {
    toBe(expected) {
      if (Object.is(actual, expected)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
        );
      }
    },
    toEqual(expected) {
      if (deepEqual(actual, expected)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} ≉ ${JSON.stringify(expected)}`,
        );
      }
    },
    toBeNull() {
      if (actual === null) {
        throw new AssertionError("expected non-null, got null");
      }
    },
    toBeUndefined() {
      if (actual === undefined) {
        throw new AssertionError("expected defined, got undefined");
      }
    },
    toContain(substr) {
      if (describeContains(actual, substr)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} NOT to contain ${JSON.stringify(substr)}`,
        );
      }
    },
    toMatch(re) {
      const r = re instanceof RegExp ? re : new RegExp(String(re));
      if (typeof actual === "string" && r.test(actual)) {
        throw new AssertionError(
          `expected ${JSON.stringify(actual)} NOT to match ${r}`,
        );
      }
    },
  };
  return api;
}

// Static helpers Vitest exposes on `expect` itself.
expect.arrayContaining = (items) => ({
  __arrayContaining: items,
  toString() {
    return `arrayContaining(${JSON.stringify(items)})`;
  },
});
expect.objectContaining = (shape) => ({
  __objectContaining: shape,
  toString() {
    return `objectContaining(${JSON.stringify(shape)})`;
  },
});
expect.stringContaining = (str) => ({
  __stringContaining: str,
});

// Re-define deepEqual to honour the asymmetric matchers above.
function deepEqualAsymmetric(a, b) {
  if (b && typeof b === "object") {
    if ("__arrayContaining" in b) {
      if (!Array.isArray(a)) return false;
      return b.__arrayContaining.every((item) =>
        a.some((x) => deepEqualAsymmetric(x, item)),
      );
    }
    if ("__objectContaining" in b) {
      if (!a || typeof a !== "object") return false;
      for (const [k, v] of Object.entries(b.__objectContaining)) {
        if (!deepEqualAsymmetric(a[k], v)) return false;
      }
      return true;
    }
    if ("__stringContaining" in b) {
      return typeof a === "string" && a.includes(b.__stringContaining);
    }
  }
  return deepEqual(a, b);
}
// Patch the closure so toEqual sees asymmetric matchers.
// (Hot-shadow `deepEqual` for matcher use — the original is still the
// strict variant exported above.)
const _deepEqual = deepEqualAsymmetric;
const _expect = expect;
function patchedExpect(actual) {
  const api = _expect(actual);
  const orig = api.toEqual.bind(api);
  api.toEqual = (expected) => {
    if (!_deepEqual(actual, expected)) {
      throw new AssertionError(
        `expected ${JSON.stringify(actual)} ≈ ${JSON.stringify(expected)}`,
      );
    }
  };
  return api;
}
patchedExpect.arrayContaining = expect.arrayContaining;
patchedExpect.objectContaining = expect.objectContaining;
patchedExpect.stringContaining = expect.stringContaining;
// Replace the global so the file-loaded tests pick up the patched version.
globalThis.expect = patchedExpect;

// Tests that touch `marvinPaths.globalHoneycombConfig()` need
// MARVIN_DATA_DIR set or they crash with "path argument undefined."
// Vitest sets it via a setup file in real runs; here we stub it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env.MARVIN_DATA_DIR = mkdtempSync(
  join(tmpdir(), "marvin-test-data-"),
);

// Inject globals so test files can use them like in Vitest.
globalThis.describe = describe;
globalThis.it = it;
globalThis.beforeEach = beforeEach;
globalThis.afterEach = afterEach;
globalThis.expect = expect;

// ----- Run targeted suites -------------------------------------------------

// We can't load every test file: some import vitest internals (vi.fn,
// fancy matchers, mock helpers) we don't shim. The list below is the
// subset whose assertions are pure-logic and use only the matchers
// supported above. Critically, this includes every audit-fix-pass
// test file (#15 / #35 policy.test.ts, #17 honeycomb-telemetry.test.ts).
const SUITES = [
  "packages/tools/tests/policy.test.ts",
  "packages/tools/tests/fs-write-policy.test.ts",
  "packages/tools/tests/fs-constants.test.ts",
  "packages/runtime/tests/fs-sandbox.test.ts",
  "packages/runtime/tests/honeycomb-telemetry.test.ts",
  "packages/runtime/tests/honeycomb-config.test.ts",
  "packages/runtime/tests/fs-write-confirm-registry.test.ts",
  "packages/git/src/argv-guards.test.ts",
  "packages/git/src/git-write-policy.test.ts",
  "packages/git/src/parse-porcelain-v2.test.ts",
  "apps/web/tests/csrf.test.ts",
  "apps/web/tests/file-tree-filter.test.ts",
  "apps/web/tests/model-picker-presets.test.ts",
  "apps/web/tests/task-role.test.ts",
  "packages/runtime/tests/scout-agent.test.ts",
];

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  fsCache: false,
  moduleCache: false,
  alias: {
    vitest: "/sessions/wizardly-optimistic-davinci/mnt/marvin/scripts/vitest-shim.mjs",
    "@marvin/tools/policy": "/sessions/wizardly-optimistic-davinci/mnt/marvin/packages/tools/src/policy.ts",
    "@marvin/tools/fs-write-policy": "/sessions/wizardly-optimistic-davinci/mnt/marvin/packages/tools/src/fs-write-policy.ts",
    "@marvin/tools/fs-constants": "/sessions/wizardly-optimistic-davinci/mnt/marvin/packages/tools/src/fs-constants.ts",
  },
});

let totalLoadFailed = 0;

for (const rel of SUITES) {
  const full = join(ROOT, rel);
  try {
    await jiti.import(full);
  } catch (err) {
    totalLoadFailed++;
    console.error(`LOAD FAIL: ${rel}\n  ${err.message}`);
  }
}

console.log("\n" + "─".repeat(60));
console.log(`${ctx.passed}/${ctx.total} test cases passed`);
if (ctx.failed.length > 0) {
  console.log(`${ctx.failed.length} failed:`);
  for (const f of ctx.failed) {
    console.log(`  ✗ ${f.path}`);
    console.log(`    ${f.error.message}`);
  }
}
if (totalLoadFailed > 0) {
  console.log(`${totalLoadFailed} suites failed to load`);
}
process.exit(ctx.failed.length > 0 || totalLoadFailed > 0 ? 1 : 0);
