import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runGrokBrowserLogin } from "../login.js";

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

describe("runGrokBrowserLogin", () => {
  it("win32 → refuses without spawning", async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = fakeSpawn(child);
    const outcome = await runGrokBrowserLogin({ binary: "/x/grok", spawnFn, platform: "win32" });
    expect(outcome).toMatchObject({ ok: false, reason: "spawn-error" });
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.error).toContain("not supported on Windows in V1");
    expect(calls).toEqual([]);
  });

  it("spawns `<binary> login` and resolves ok on exit 0 (Grok writes its own credential store)", async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = fakeSpawn(child);
    const urls: string[] = [];
    const run = runGrokBrowserLogin({
      binary: "/home/op/.grok/bin/grok",
      onAuthUrl: (u) => urls.push(u),
      spawnFn,
    });

    child.emitStdout("Opening browser…\nIf it didn't open, visit https://accounts.x.ai/oauth/authorize?x=1\n");
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ command: "/home/op/.grok/bin/grok", args: ["login"] }]);
    expect(urls).toEqual(["https://accounts.x.ai/oauth/authorize?x=1"]);
  });

  it("never passes --device-auth (that flow stays operator-run)", async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = fakeSpawn(child);
    const run = runGrokBrowserLogin({ binary: "/x/grok", spawnFn });

    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{ command: "/x/grok", args: ["login"] }]);
  });

  it("reports exit-nonzero with the provider's own failure text", async () => {
    const child = new FakeChild();
    const { spawnFn } = fakeSpawn(child);
    const run = runGrokBrowserLogin({ binary: "/x/grok", spawnFn });

    child.stderr.emit("data", Buffer.from("login failed: network unreachable\n", "utf-8"));
    child.close(1);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("exit-nonzero");
    expect(outcome.error).toContain("network unreachable");
  });
});
