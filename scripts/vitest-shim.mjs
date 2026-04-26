/**
 * Tiny Vitest API shim used by `run-tests-via-jiti.mjs`. Re-exports the
 * globals the runner installs so `import { describe, it, expect, ... }
 * from "vitest"` resolves cleanly when jiti loads a test file with
 * an aliased "vitest" specifier.
 */
export const describe = (...args) => globalThis.describe(...args);
export const it = (...args) => globalThis.it(...args);
export const test = (...args) => globalThis.it(...args);
export const beforeEach = (...args) => globalThis.beforeEach(...args);
export const afterEach = (...args) => globalThis.afterEach(...args);
export const expect = (...args) => globalThis.expect(...args);
// Stubs for parts of the API our supported test files don't use.
// They throw lazily so a test that DOES use them fails clearly.
export const vi = new Proxy(
  {},
  {
    get(_t, key) {
      throw new Error(
        `vitest shim: vi.${String(key)}() not implemented (use the real runner locally)`,
      );
    },
  },
);
