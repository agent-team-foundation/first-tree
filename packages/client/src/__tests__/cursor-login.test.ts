import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runCursorBrowserLogin } from "../runtime/cursor-login.js";

/** Minimal stand-in for a spawned child: stdout/stderr emitters + kill(). */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emitStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text, "utf-8"));
  }
  close(code: number): void {
    this.emit("close", code);
  }
}

function fakeSpawn(child: FakeChild): {
  spawnFn: typeof import("node:child_process").spawn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn = ((command: string, args: string[]) => {
    calls.push({ command, args });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnFn, calls };
}

describe("runCursorBrowserLogin", () => {
  it("spawns `<binary> login` and resolves ok on exit 0 (Cursor writes its own credential store)", async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = fakeSpawn(child);
    const urls: string[] = [];
    const run = runCursorBrowserLogin({
      binary: "/home/op/.local/bin/cursor-agent",
      onAuthUrl: (u) => urls.push(u),
      spawnFn,
    });

    child.emitStdout("Opening browser…\nIf it didn't open, visit https://cursor.com/loginDeepControl?x=1\n");
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ command: "/home/op/.local/bin/cursor-agent", args: ["login"] }]);
    expect(urls).toEqual(["https://cursor.com/loginDeepControl?x=1"]);
  });

  it("reports exit-nonzero with the provider's own failure text", async () => {
    const child = new FakeChild();
    const { spawnFn } = fakeSpawn(child);
    const run = runCursorBrowserLogin({ binary: "/x/cursor-agent", spawnFn });

    child.stderr.emit("data", Buffer.from("login failed: network unreachable\n", "utf-8"));
    child.close(1);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("exit-nonzero");
    expect(outcome.error).toContain("network unreachable");
  });
});
