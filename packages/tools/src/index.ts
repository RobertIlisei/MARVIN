// Tool definitions + policy for MARVIN.
// Each tool is a thin shim over filesystem / subprocess / HTTP. Tools come
// in three policy classes — see policy.ts.
//
// Phase 2 target: implement Bash, Edit, Write, Read, Grep, Glob, WebFetch,
// WebSearch. Phase 1 stub exists only so the runtime package can typecheck
// against the future tool-call schema.

export {
  HARD_DENY_DIR_SEGMENTS,
  hasDenySegment,
  IGNORE_DIR_NAMES,
  isSecretFileName,
  SECRET_FILE_PATTERNS,
} from "./fs-constants";
export {
  type FsWriteClass,
  type FsWriteDecision,
  type FsWriteOp,
  type FsWriteSeverity,
  fsWritePolicy,
  WRITE_SIZE_MAX_BYTES,
} from "./fs-write-policy";
export {
  type ToolName,
  type ToolPolicyClass,
  toolPolicy,
} from "./policy";
