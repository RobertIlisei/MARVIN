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
export {
  IGNORE_DIR_NAMES,
  HARD_DENY_DIR_SEGMENTS,
  SECRET_FILE_PATTERNS,
  hasDenySegment,
  isSecretFileName,
} from "./fs-constants";
export {
  fsWritePolicy,
  WRITE_SIZE_MAX_BYTES,
  type FsWriteOp,
  type FsWriteClass,
  type FsWriteDecision,
  type FsWriteSeverity,
} from "./fs-write-policy";
