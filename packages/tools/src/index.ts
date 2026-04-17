// Tool definitions + policy for MARVIN.
// Each tool is a thin shim over filesystem / subprocess / HTTP. Tools come
// in three policy classes — see policy.ts.
//
// Phase 2 target: implement Bash, Edit, Write, Read, Grep, Glob, WebFetch,
// WebSearch. Phase 1 stub exists only so the runtime package can typecheck
// against the future tool-call schema.

export {
  toolPolicy,
  type ToolName,
  type ToolPolicyClass,
} from "./policy";
