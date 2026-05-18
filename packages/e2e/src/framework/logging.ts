import { createWriteStream, type WriteStream } from "node:fs";
import { resolve } from "node:path";

/**
 * Log retention policy (see proposals/hub-local-e2e-framework.20260518.md §七):
 *   - Locally, keep the most recent 20 runs OR 7 days, whichever is shorter.
 *     `scripts/clean.ts` does the pruning; this module only writes.
 *   - CI uploads failed-run logs as an artifact (handled in the workflow).
 */

export type ComponentLogger = {
  component: string;
  /** Pipe a child process's stdio. Each line is prefixed `[component] …`. */
  pipe: (chunk: Buffer | string) => void;
  /** Last N lines kept in memory for failure dumps. */
  tail: () => string[];
  close: () => void;
};

export function createComponentLogger(runDir: string, component: string, tailSize = 50): ComponentLogger {
  const file = resolve(runDir, `${component}.log`);
  const stream: WriteStream = createWriteStream(file, { flags: "a" });
  const ring: string[] = [];

  const handle = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const formatted = `[${component}] ${line}`;
      stream.write(`${formatted}\n`);
      ring.push(line);
      if (ring.length > tailSize) ring.shift();
    }
  };

  return {
    component,
    pipe: handle,
    tail: () => [...ring],
    close: () => stream.end(),
  };
}

export function dumpTailToConsole(loggers: ComponentLogger[]): void {
  for (const logger of loggers) {
    const tail = logger.tail();
    if (tail.length === 0) continue;
    console.error(`\n──── last ${tail.length} lines from [${logger.component}] ────`);
    for (const line of tail) console.error(`  ${line}`);
  }
}
