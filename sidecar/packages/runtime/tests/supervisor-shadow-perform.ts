import type { VerbPerform } from "../src/supervisor-mcp";

/**
 * Milestone 4 — the `perform` a shadow-only fixture injects. Every function
 * throws: a test that passes with it proves the verb performed nothing.
 */
const never = (what: string) => () => {
  throw new Error(`shadow fixture: ${what} must not be performed`);
};
export const SHADOW_PERFORM: VerbPerform = {
  answer: never("answer"),
  send: never("send"),
  cancel: never("cancel"),
  setPosture: never("setPosture"),
  confirm: never("confirm"),
};
