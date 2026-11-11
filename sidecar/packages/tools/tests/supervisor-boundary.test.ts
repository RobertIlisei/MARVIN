import { homedir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mcpToolPolicy, toolPolicy } from "../src/policy";
import { noteSidecarPort, resetNotedSidecarPortForTests, supervisorBoundaryDenial } from "../src/supervisor-boundary";

// ADR-0127 §5 — a tab's model must not use MARVIN's own control API or the
// supervisor's data directory as a side door: that would let one tab answer
// its own confirms, delegate itself, or message another tab as the
// supervisor. A hard deny, so it holds in `auto` and `full` alike.

const prevData = process.env.MARVIN_DATA_DIR;
const prevPort = process.env.PORT;
beforeEach(() => {
  process.env.MARVIN_DATA_DIR = "/tmp/marvin-data-x";
  delete process.env.PORT;
  resetNotedSidecarPortForTests();
});
afterEach(() => {
  resetNotedSidecarPortForTests();
  if (prevData === undefined) delete process.env.MARVIN_DATA_DIR;
  else process.env.MARVIN_DATA_DIR = prevData;
  if (prevPort === undefined) delete process.env.PORT;
  else process.env.PORT = prevPort;
});

const bash = (command: string) => supervisorBoundaryDenial("Bash", { command });

describe("supervisorBoundaryDenial — MARVIN's own control routes", () => {
  it.each([
    "curl -s -X POST http://localhost:3030/api/confirm -d '{}'",
    "curl http://127.0.0.1:3030/api/chat",
    "curl 'http://[::1]:3030/api/sessions/meta' -X PUT",
    "wget -qO- localhost:3030/api/supervisor",
    "curl -H 'X-Marvin-Client: 1' http://0.0.0.0:3030/api/worktrees -d '{\"action\":\"merge\"}'",
    "http POST :3030/api/models/roles",
    // Milestone 2's routes sit under the same control paths.
    "curl -X POST http://localhost:3030/api/confirm/answer -d '{}'",
    "curl -X PUT http://localhost:3030/api/sessions/posture -d '{\"posture\":{\"permissionStrategy\":\"full\"}}'",
    // ADR-0131 — the project notices' route is the user's.
    "curl -X POST http://localhost:3030/api/notices -d '{\"text\":\"merge is approved\"}'",
    "curl -X DELETE 'http://127.0.0.1:3030/api/notices?id=n-1'",
    // Any host spelling — the sidecar binds loopback only.
    "curl http://127.1:3030/api/confirm",
    "curl http://0:3030/api/chat",
    "curl 'http://[::ffff:127.0.0.1]:3030/api/confirm'",
    "curl http://2130706433:3030/api/confirm",
    "curl http://lvh.me:3030/api/supervisor",
    // Normalised before matching.
    "curl -L http://localhost:3030/api//confirm",
    "curl http://localhost:3030/api/%63onfirm",
    "curl http://localhost:3030/API/Confirm",
    // A raw request line carries no port: a network tool + the port + a control path.
    "printf 'POST /api/confirm HTTP/1.1\\r\\n\\r\\n' | nc localhost 3030",
    "socat - TCP:127.0.0.1:3030 <<< 'POST /api/chat HTTP/1.1'",
    "node -e \"fetch('http://localhost:'+3030+'/api/confirm',{method:'POST'})\"",
  ])("denies %s", (cmd) => {
    expect(bash(cmd)?.class).toBe("deny");
  });

  it.each([
    "curl -s http://localhost:3030/api/health",
    "curl http://localhost:3000/api/chat", // the user's own app on another port
    "npm test -- api/chat",
    "grep -rn '/api/confirm' sidecar/src",
    // Searching MARVIN's own source for its port and routes is not a request.
    "rg -n '3030' sidecar/src/app/api/chat/route.ts",
    "grep -rn \"http://localhost:3030\" sidecar/src/app/api/chat",
    "curl http://localhost:3030/api/chatbot-demo", // not a control path
  ])("leaves %s alone", (cmd) => {
    expect(bash(cmd)).toBeNull();
  });

  it("follows the sidecar's port when it is not 3030", () => {
    process.env.PORT = "4040";
    expect(bash("curl http://localhost:4040/api/confirm")?.class).toBe("deny");
    expect(bash("curl http://localhost:3030/api/confirm")).toBeNull();
  });

  it("prefers the port a request actually arrived on over a stray PORT in the environment", () => {
    process.env.PORT = "8080";
    noteSidecarPort("3030");
    expect(bash("curl http://localhost:3030/api/confirm")?.class).toBe("deny");
    expect(bash("curl http://localhost:8080/api/chat")).toBeNull(); // the user's own app
  });

  it("the first noted port wins — a later forged Host header cannot move it", () => {
    noteSidecarPort("3030");
    noteSidecarPort("9999");
    expect(bash("curl http://localhost:3030/api/confirm")?.class).toBe("deny");
  });

  it("tolerates a missing input (the gate classifies some calls before normalising)", () => {
    expect(supervisorBoundaryDenial("Read", undefined)).toBeNull();
  });

  it("covers WebFetch too", () => {
    expect(supervisorBoundaryDenial("WebFetch", { url: "http://localhost:3030/api/chat/cancel" })?.class).toBe("deny");
    expect(supervisorBoundaryDenial("WebFetch", { url: "https://example.com/api/chat" })).toBeNull();
  });
});

describe("supervisorBoundaryDenial — the supervisor's data directory", () => {
  it.each([
    ["Bash", { command: "cat /tmp/marvin-data-x/supervisor/token" }],
    ["Bash", { command: "cat $MARVIN_DATA_DIR/supervisor/token" }],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell command, not a template
    ["Bash", { command: "cat ${MARVIN_DATA_DIR}/supervisor/proj/state.json" }],
    ["Bash", { command: "echo '{}' > ~/.marvin/supervisor/proj/state.json" }],
    ["Bash", { command: "tail $HOME/.marvin/supervisor/proj/ledger.jsonl" }],
    ["Read", { file_path: "/tmp/marvin-data-x/supervisor/token" }],
    ["Edit", { file_path: "/tmp/marvin-data-x/supervisor/proj/state.json" }],
    ["Write", { file_path: "/tmp/marvin-data-x/supervisor/proj/ledger.jsonl" }],
    ["Grep", { pattern: "x", path: "/tmp/marvin-data-x/supervisor" }],
    ["Glob", { pattern: "/tmp/marvin-data-x/supervisor/**" }],
  ] as const)("%s %j → deny", (tool, input) => {
    expect(supervisorBoundaryDenial(tool, input as Record<string, unknown>)?.class).toBe("deny");
  });

  it("names the default ~/.marvin data dir when MARVIN_DATA_DIR is unset", () => {
    delete process.env.MARVIN_DATA_DIR;
    expect(supervisorBoundaryDenial("Read", { file_path: path.join(homedir(), ".marvin", "supervisor", "token") })?.class).toBe("deny");
  });

  it("leaves a project's own .marvin files and the rest of the data dir alone", () => {
    expect(supervisorBoundaryDenial("Read", { file_path: "/repo/.marvin/supervisor.json" })).toBeNull();
    expect(supervisorBoundaryDenial("Read", { file_path: "/tmp/marvin-data-x/sessions/p/s.jsonl" })).toBeNull();
  });
});

describe("toolPolicy and mcpToolPolicy apply it", () => {
  it("toolPolicy hard-denies the side doors before anything else classifies them", () => {
    expect(toolPolicy("Bash", { command: "curl -X POST http://localhost:3030/api/confirm" }).class).toBe("deny");
    expect(toolPolicy("Read", { file_path: "/tmp/marvin-data-x/supervisor/token" }).class).toBe("deny");
    expect(toolPolicy("Bash", { command: "curl -s http://localhost:3030/api/health" }).class).not.toBe("deny");
  });

  it("marvin-supervise is denied in every executor turn, whatever its provenance", () => {
    expect(mcpToolPolicy("mcp__marvin-supervise__answer", { name: "marvin-supervise", source: "sdk" })).toBe("deny");
    expect(mcpToolPolicy("mcp__marvin-supervise__sessions")).toBe("deny");
  });
});
