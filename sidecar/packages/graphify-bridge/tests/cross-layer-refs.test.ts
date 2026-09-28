import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { crossLayerReferences, renderCrossLayer, routeSegments } from "../src/cross-layer-refs";

// ADR-0121 — the three consumers the call graph missed on 2026-09-28, rebuilt
// as a tiny repository: an enum value the spec never listed, a config file a
// script mounts by name, and a route a web page calls by URL string.
describe("cross-layer references", () => {
  let repo: string;
  const write = (rel: string, body: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString();

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "marvin-xlr-")));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@x");
    git("config", "user.name", "t");
    write(
      "api/DocumentType.java",
      "public enum DocumentType {\n  FACTURA_FISCALA,\n  BULETIN_ANALIZA,\n  CERTIFICAT_ECOLOGIC,\n}\n",
    );
    write(
      "spec/document.openapi.yaml",
      "DocumentType:\n  enum: [FACTURA_FISCALA, BULETIN_ANALIZA, CERTIFICAT_ECOLOGIC]\n",
    );
    write("infra/garage.toml", 'rpc_bind_addr = "[::]:3901"\nrpc_secret = "abc"\n');
    write("scripts/restore.sh", 'cp infra/garage.toml /tmp/g.toml\ndocker run -v /tmp/g.toml:/etc/garage.toml garage\n');
    write(
      "api/ProfileController.java",
      '@GetMapping("/tenants/{id}/compliance-profile/ppp-professional-user")\nclass ProfileController { void get() { requireOwnTenant(); } }\n',
    );
    write("web/tratamente.tsx", "fetch(`/tenants/${tid}/compliance-profile/ppp-professional-user`)\n");
    git("add", ".");
    git("commit", "-qm", "base");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("finds the spec that lists an enum's siblings but not the new value", async () => {
    write(
      "api/DocumentType.java",
      "public enum DocumentType {\n  FACTURA_FISCALA,\n  BULETIN_ANALIZA,\n  CERTIFICAT_ECOLOGIC,\n  DOVADA_DEPUNERE_AUTORITATE,\n}\n",
    );
    const r = await crossLayerReferences(repo, "HEAD", ["api/DocumentType.java"]);
    expect(r.parityGaps.map((g) => [g.token, g.file])).toEqual([["DOVADA_DEPUNERE_AUTORITATE", "spec/document.openapi.yaml"]]);
    expect(renderCrossLayer(r)).toContain("missing from spec/document.openapi.yaml");
  });

  it("finds a script that mounts a changed config file by name", async () => {
    write("infra/garage.toml", 'rpc_bind_addr = "[::]:3901"\nrpc_secret_file = "/run/secrets/garage_rpc_secret"\n');
    const r = await crossLayerReferences(repo, "HEAD", ["infra/garage.toml"]);
    const file = r.refs.find((x) => x.token === "garage.toml");
    expect(file?.kind).toBe("file");
    expect(file?.locations[0]).toMatch(/^scripts\/restore\.sh:1$/);
  });

  it("finds a web page that calls a changed controller's route by URL string", async () => {
    write(
      "api/ProfileController.java",
      '@GetMapping("/tenants/{id}/compliance-profile/ppp-professional-user")\nclass ProfileController { void get() { requireActingTenant(); } }\n',
    );
    const r = await crossLayerReferences(repo, "HEAD", ["api/ProfileController.java"]);
    const route = r.refs.find((x) => x.token === "ppp-professional-user");
    expect(route?.kind).toBe("path");
    expect(route?.locations).toEqual(["web/tratamente.tsx:1"]);
  });

  it("never reports the branch's own files, and reports nothing for a self-contained change", async () => {
    write("web/tratamente.tsx", "fetch(`/tenants/${tid}/compliance-profile/ppp-professional-user`) // edited\n");
    const r = await crossLayerReferences(repo, "HEAD", ["web/tratamente.tsx"]);
    expect(r.refs.every((x) => x.locations.every((l) => !l.startsWith("web/tratamente.tsx")))).toBe(true);
  });

  it("keeps only static, distinctive route segments", () => {
    expect([...routeSegments('x("/api/v1/{tenantId}/compliance-profile/ppp-professional-user")')]).toEqual([
      "compliance-profile",
      "ppp-professional-user",
    ]);
  });
});
