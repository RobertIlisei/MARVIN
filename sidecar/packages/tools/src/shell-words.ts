// Shell words — the quote-, escape- and `$(…)`-aware splitter shared by the
// graphify-first read classifier (`@marvin/runtime/bash-search`) and the
// gate's git / gh / glab parser (`vcs-command.ts`). One tokenizer, so the two
// can never disagree about where a command starts.

export interface Stage {
  text: string;
  /** 0 for the first stage of a pipeline; >0 downstream of a `|`. */
  pipeIndex: number;
}

/** Split into pipeline stages at `&&`, `||`, `;`, `&`, newline and `|`,
 *  honouring quotes, escapes and `$(…)` nesting. */
export function splitStages(command: string): Stage[] {
  const stages: Stage[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let depth = 0;
  let pipeIndex = 0;
  const flush = (nextPipe: number) => {
    if (buf.trim()) stages.push({ text: buf.trim(), pipeIndex });
    buf = "";
    pipeIndex = nextPipe;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    const n = command[i + 1];
    if (quote) {
      if (c === "\\" && quote === '"') {
        buf += c + (n ?? "");
        i++;
        continue;
      }
      if (c === quote) quote = null;
      buf += c;
      continue;
    }
    if (c === "\\") {
      buf += c + (n ?? "");
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      buf += c;
      continue;
    }
    if (c === "$" && n === "(") {
      depth++;
      buf += "$(";
      i++;
      continue;
    }
    if (depth > 0) {
      if (c === "(") depth++;
      if (c === ")") depth--;
      buf += c;
      continue;
    }
    if ((c === "&" && n === "&") || (c === "|" && n === "|")) {
      flush(0);
      i++;
      continue;
    }
    if (c === "|") {
      const next = pipeIndex + 1;
      flush(next);
      continue;
    }
    if (c === ";" || c === "\n") {
      flush(0);
      continue;
    }
    if (c === "&" && n !== ">" && command[i - 1] !== ">" && command[i - 1] !== "<") {
      flush(0);
      continue;
    }
    buf += c;
  }
  flush(0);
  return stages;
}

/** Quote-aware word split; quotes are removed. */
export function stageWords(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s"']+)/g;
  let cur = "";
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Adjacent pieces (`--glob='*.ts'`) belong to one word.
    const piece = m[1] ?? m[2] ?? m[3] ?? "";
    if (last === m.index && cur) cur += piece;
    else {
      if (cur || last !== -1) out.push(cur);
      cur = piece;
    }
    last = re.lastIndex;
  }
  if (last !== -1) out.push(cur);
  return out.filter((w, i) => w !== "" || i > 0);
}
