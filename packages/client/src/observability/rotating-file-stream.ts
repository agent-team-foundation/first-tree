import { closeSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { Writable } from "node:stream";

/**
 * Thin size-triggered log rotator used by the background-service logger.
 *
 * Keeps the active file at `path`; on write-after-overflow it renames
 * `path` → `path.1`, shifting older rotated files up to `path.<maxFiles>`
 * and unlinking the oldest. Deliberately synchronous — logger writes arrive
 * one line at a time, and the alternative (a queue + fs.promises) would add
 * a buffering surface that is never observed by the consumer.
 *
 * Not a general-purpose replacement for logrotate — no time-based triggers,
 * no compression. The trade-off is zero extra dependencies and a few dozen
 * lines of code that live in the same tree as the logger that consumes it.
 */
export type RotatingFileStreamOptions = {
  /** Target path of the active log file. */
  path: string;
  /** Rotate after the file reaches or exceeds this size in bytes. */
  maxBytes: number;
  /** Keep this many rotated files (`.1` … `.N`). Oldest is dropped on rotate. */
  maxFiles: number;
};

export class RotatingFileStream extends Writable {
  private size: number;
  private fd: number;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(options: RotatingFileStreamOptions) {
    super();
    this.path = options.path;
    this.maxBytes = options.maxBytes;
    this.maxFiles = Math.max(1, options.maxFiles);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      this.size = statSync(this.path).size;
    } catch {
      this.size = 0;
    }
    this.fd = openSync(this.path, "a", 0o600);
  }

  _write(chunk: Buffer | string, _enc: BufferEncoding, callback: (err?: Error | null) => void): void {
    try {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      writeSync(this.fd, buf);
      this.size += buf.length;
      if (this.size >= this.maxBytes) {
        this.rotate();
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (err?: Error | null) => void): void {
    try {
      closeSync(this.fd);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private rotate(): void {
    closeSync(this.fd);
    // Walk high → low so we never overwrite a file before moving its current
    // occupant out of the way. Missing files are expected on a fresh service
    // (rotation count still below maxFiles), so swallow ENOENT.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      renameIfExists(`${this.path}.${i}`, `${this.path}.${i + 1}`);
    }
    unlinkIfExists(`${this.path}.1`);
    renameSync(this.path, `${this.path}.1`);
    this.fd = openSync(this.path, "a", 0o600);
    this.size = 0;
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}

function renameIfExists(from: string, to: string): void {
  try {
    unlinkIfExists(to);
    renameSync(from, to);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
