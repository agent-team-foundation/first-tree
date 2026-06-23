import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runCodexBrowserLogin, stripAnsi } from "../runtime/codex-login.js";

const ESC = "\u001b";

describe("stripAnsi", () => {
  it("removes CSI colour escapes including the ESC byte", () => {
    expect(stripAnsi(`${ESC}[94mhello${ESC}[0m`)).toBe("hello");
  });

  it("is a noop on plain text", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

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
  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf-8"));
  }
  close(code: number): void {
    this.emit("close", code);
  }
}

// The fake child structurally matches the slice of ChildProcessWithoutNullStreams
// the runner touches; cast through unknown at the spawn seam only.
function fakeSpawn(child: FakeChild): typeof import("node:child_process").spawn {
  return (() => child) as unknown as typeof import("node:child_process").spawn;
}

describe("runCodexBrowserLogin", () => {
  it("resolves ok on exit 0 (codex wrote auth.json) and surfaces a fallback URL once", async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      onAuthUrl: (u) => urls.push(u),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout("Starting local login server…\nIf it didn't open, visit https://auth.openai.com/auth?x=1\n");
    child.emitStdout("more output https://example.com/other\n"); // must not re-fire
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://auth.openai.com/auth?x=1"]);
  });

  it("reports exit-nonzero with the stderr tail when login fails", async () => {
    const child = new FakeChild();
    const run = runCodexBrowserLogin({ binary: "/bundled/codex", spawnFn: fakeSpawn(child) });
    child.emitStderr("could not open a browser on this host\n");
    child.close(1);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("exit-nonzero");
      expect(outcome.error).toContain("could not open a browser");
    }
  });

  it("resolves aborted and kills the child when the operator cancels", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      signal: controller.signal,
      spawnFn: fakeSpawn(child),
    });
    controller.abort();
    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
    expect(child.killed).toBe(true);
  });

  it("maps a spawn throw to spawn-error", async () => {
    const throwingSpawn = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runCodexBrowserLogin({ binary: "/nope/codex", spawnFn: throwingSpawn });
    expect(outcome).toEqual({ ok: false, reason: "spawn-error", error: "ENOENT" });
  });
});
