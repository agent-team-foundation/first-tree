import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentOutput, RuntimeMessage } from "./protocol.js";
import { agentOutputSchema } from "./protocol.js";

export type ProcessHandleConfig = {
  command: string;
  env?: Record<string, string>;
  onOutput: (msg: AgentOutput) => void;
  onExit: (code: number | null) => void;
  onError: (error: Error) => void;
};

export class ProcessHandle {
  private child: ChildProcess | null = null;
  private readonly config: ProcessHandleConfig;
  private exited = false;

  constructor(config: ProcessHandleConfig) {
    this.config = config;
  }

  /** Spawn the child process. */
  start(): void {
    const child = spawn(this.config.command, {
      shell: true,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.config.env },
    });

    child.on("error", (err) => {
      this.config.onError(err);
    });

    child.on("close", (code) => {
      this.exited = true;
      this.config.onExit(code);
    });

    // Read stdout line by line, parse NDJSON
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const parsed = agentOutputSchema.parse(JSON.parse(line));
          this.config.onOutput(parsed);
        } catch {
          // Ignore non-protocol lines (e.g. debug output from the subprocess)
        }
      });
    }

    this.child = child;
  }

  /** Send a protocol message to child stdin. */
  send(msg: RuntimeMessage): void {
    if (!this.child?.stdin || !this.child.stdin.writable) {
      throw new Error("Child process stdin is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  /** Whether the process is still running. */
  isAlive(): boolean {
    return !this.exited && this.child !== null;
  }

  /** Send SIGTERM (or specified signal) to the child. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.child && !this.exited) {
      this.child.kill(signal);
    }
  }

  /** Graceful shutdown: send shutdown message, wait, then force kill. */
  async gracefulShutdown(timeoutMs = 5000): Promise<void> {
    if (!this.isAlive()) return;

    try {
      this.send({ type: "shutdown" });
    } catch {
      // stdin may already be closed
    }

    const exited = await this.waitForExit(timeoutMs);
    if (!exited) {
      this.kill("SIGTERM");
      const exitedAfterTerm = await this.waitForExit(5000);
      if (!exitedAfterTerm) {
        this.kill("SIGKILL");
      }
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child?.removeListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      this.child?.once("close", onClose);
    });
  }
}
