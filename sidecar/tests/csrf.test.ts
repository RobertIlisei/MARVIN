import { describe, expect, it } from "vitest";

import {
  MARVIN_CLIENT_HEADER,
  MARVIN_CLIENT_VALUE,
  marvinFetch,
  requireMarvinClient,
} from "../src/lib/csrf";

// CSRF gate tests. The guard is load-bearing — without it, any browser
// tab at another origin can POST to localhost:3030 and trigger every
// mutating route in the app. These tests pin the two invariants:
//
//   1. The server guard blocks requests without the header.
//   2. The client wrapper attaches the header on mutating methods
//      automatically (so new code can't accidentally regress).

// Minimal NextRequest stand-in — the guard only reads headers.
function makeReq(headers: Record<string, string>): {
  headers: { get(name: string): string | null };
} {
  const h = new Headers(headers);
  return {
    headers: {
      get: (name: string) => h.get(name),
    },
  };
}

describe("requireMarvinClient", () => {
  it("returns null when the CSRF header is present and correct", () => {
    const res = requireMarvinClient(
      // biome-ignore lint/suspicious/noExplicitAny: test-only stand-in for NextRequest
      makeReq({ [MARVIN_CLIENT_HEADER]: MARVIN_CLIENT_VALUE }) as any,
    );
    expect(res).toBeNull();
  });

  it("returns a 403 when the header is missing", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only stand-in
    const res = requireMarvinClient(makeReq({}) as any);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string; detail: string };
    // The error body is diagnostic — a legit developer hitting the
    // endpoint via curl needs to know which header to send. Attackers
    // reading the response gain nothing (they can't add the header
    // from a drive-by tab by design; the constraint is browser-enforced).
    expect(body.error).toBe("csrf-guard");
    expect(body.detail).toContain(MARVIN_CLIENT_HEADER);
    expect(body.detail).toContain(MARVIN_CLIENT_VALUE);
  });

  it("returns a 403 when the header value is wrong", () => {
    const res = requireMarvinClient(
      // biome-ignore lint/suspicious/noExplicitAny: test-only stand-in
      makeReq({ [MARVIN_CLIENT_HEADER]: "0" }) as any,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("is case-insensitive on the header name (HTTP semantics)", () => {
    // HTTP headers are case-insensitive. A client sending
    // "X-MARVIN-CLIENT" must be accepted the same as "x-marvin-client".
    const res = requireMarvinClient(
      // biome-ignore lint/suspicious/noExplicitAny: test-only stand-in
      makeReq({ "X-MARVIN-CLIENT": MARVIN_CLIENT_VALUE }) as any,
    );
    expect(res).toBeNull();
  });
});

describe("marvinFetch", () => {
  // We stub global.fetch so we can inspect what the wrapper actually sends.
  // Every test restores the original fetch to avoid leaking state.
  const origFetch = global.fetch;
  let captured: { input: RequestInfo | URL; init: RequestInit | undefined } | null;

  // biome-ignore lint/suspicious/noExplicitAny: test-only fetch stub
  function stubFetch(): any {
    captured = null;
    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      captured = { input, init };
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof global.fetch;
  }

  function restore(): void {
    global.fetch = origFetch;
    captured = null;
  }

  it("attaches the CSRF header on POST", async () => {
    stubFetch();
    try {
      await marvinFetch("/api/test", {
        method: "POST",
        body: JSON.stringify({ hello: "world" }),
      });
      expect(captured).not.toBeNull();
      const headers = new Headers(captured!.init!.headers);
      expect(headers.get(MARVIN_CLIENT_HEADER)).toBe(MARVIN_CLIENT_VALUE);
    } finally {
      restore();
    }
  });

  it("attaches the CSRF header on DELETE", async () => {
    stubFetch();
    try {
      await marvinFetch("/api/test?id=1", { method: "DELETE" });
      const headers = new Headers(captured!.init!.headers);
      expect(headers.get(MARVIN_CLIENT_HEADER)).toBe(MARVIN_CLIENT_VALUE);
    } finally {
      restore();
    }
  });

  it("does NOT attach the header on GET", async () => {
    // GET doesn't need the guard (SOP blocks cross-origin reads, and
    // adding the header would force preflight on every trivial read).
    stubFetch();
    try {
      await marvinFetch("/api/health");
      const headers = new Headers(captured!.init!.headers);
      expect(headers.get(MARVIN_CLIENT_HEADER)).toBeNull();
    } finally {
      restore();
    }
  });

  it("auto-defaults Content-Type to application/json on string bodies", async () => {
    stubFetch();
    try {
      await marvinFetch("/api/test", {
        method: "POST",
        body: JSON.stringify({ x: 1 }),
      });
      const headers = new Headers(captured!.init!.headers);
      expect(headers.get("Content-Type")).toBe("application/json");
    } finally {
      restore();
    }
  });

  it("preserves an explicit Content-Type (multipart, custom, etc.)", async () => {
    // Multipart uploads MUST keep their own boundary-bearing
    // Content-Type; overwriting it breaks the request.
    stubFetch();
    try {
      const form = new FormData();
      form.append("file", new Blob(["x"]), "x.txt");
      await marvinFetch("/api/files/write/upload", {
        method: "POST",
        body: form,
      });
      const headers = new Headers(captured!.init!.headers);
      // The wrapper shouldn't add Content-Type on FormData bodies
      // (fetch itself sets it to multipart/form-data with a boundary).
      expect(headers.get("Content-Type")).toBeNull();
      // But the CSRF header still goes on.
      expect(headers.get(MARVIN_CLIENT_HEADER)).toBe(MARVIN_CLIENT_VALUE);
    } finally {
      restore();
    }
  });
});
