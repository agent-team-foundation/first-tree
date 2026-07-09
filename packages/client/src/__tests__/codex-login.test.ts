import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { runCodexBrowserLogin, stripAnsi } from "../runtime/codex-login.js";
import { extractAuthUrl } from "../runtime/runtime-login.js";

const ESC = "\u001b";

describe("extractAuthUrl", () => {
  it("returns null for a loopback-only output (the CLI's local callback server, not a sign-in page)", () => {
    // codex auto-opens the browser and prints only its local server line. That
    // origin's root 404s, so surfacing it as "Open the sign-in page" is the QA
    // #1225 / redirect-404 bug — we want no fallback link here.
    expect(extractAuthUrl("Starting local login server on http://localhost:1455.\n")).toBeNull();
    expect(extractAuthUrl("listening on http://127.0.0.1:1455\n")).toBeNull();
  });

  it("captures the external provider URL, skipping the loopback line", () => {
    const url = extractAuthUrl(
      "Starting local login server on http://localhost:1455.\nIf it didn't open, navigate to https://auth.openai.com/oauth/authorize?x=1\n",
    );
    expect(url).toBe("https://auth.openai.com/oauth/authorize?x=1");
    expect(() => new URL(url ?? "")).not.toThrow();
  });

  it("strips trailing sentence punctuation so the result parses as a URL", () => {
    const url = extractAuthUrl("If it didn't open, visit https://auth.openai.com/oauth?x=1.\n");
    expect(url).toBe("https://auth.openai.com/oauth?x=1");
    expect(() => new URL(url ?? "")).not.toThrow();
  });

  it("trims a wrapping paren but keeps a real query string", () => {
    expect(extractAuthUrl("(see https://auth.openai.com/auth?code=ab_c1)\n")).toBe(
      "https://auth.openai.com/auth?code=ab_c1",
    );
  });

  it("returns null until the URL is whitespace-terminated (no truncated capture across chunks)", () => {
    expect(extractAuthUrl("…navigate to https://auth.openai.com/x")).toBeNull();
    expect(extractAuthUrl("…navigate to https://auth.openai.com/x\n")).toBe("https://auth.openai.com/x");
  });

  it("returns null when there is no URL yet", () => {
    expect(extractAuthUrl("Starting local login server…\n")).toBeNull();
  });

  it("skips malformed URL tokens and continues scanning", () => {
    expect(extractAuthUrl("open https://[broken\nthen https://auth.openai.com/ok\n")).toBe(
      "https://auth.openai.com/ok",
    );
  });
});

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
    const rawOutput: string[] = [];
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      onAuthUrl: (u) => urls.push(u),
      onRawOutput: (chunk) => rawOutput.push(chunk),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout("Starting local login server…\nIf it didn't open, visit https://auth.openai.com/auth?x=1\n");
    child.emitStdout("more output https://example.com/other\n"); // must not re-fire
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://auth.openai.com/auth?x=1"]);
    expect(rawOutput.join("")).toContain("Starting local login server");
  });

  it("does NOT surface the loopback callback server as a fallback link (QA #1225 / redirect-404)", async () => {
    // codex auto-opened the browser and printed only its local server. That
    // origin's root 404s, so the fallback link must stay absent rather than
    // point users at a dead URL.
    const child = new FakeChild();
    const urls: string[] = [];
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      onAuthUrl: (u) => urls.push(u),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout("Starting local login server.\nIf it didn't open, visit http://localhost:1455.\n");
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(urls).toEqual([]);
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

  it("returns aborted without spawning when the signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawnFn = vi.fn() as unknown as typeof import("node:child_process").spawn;

    const outcome = await runCodexBrowserLogin({
      binary: "/bundled/codex",
      signal: controller.signal,
      spawnFn,
    });

    expect(outcome).toEqual({ ok: false, reason: "aborted", error: "codex login aborted before start" });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("maps child process error events to spawn-error and kills the child", async () => {
    const child = new FakeChild();
    const run = runCodexBrowserLogin({ binary: "/bundled/codex", spawnFn: fakeSpawn(child) });
    child.emit("error", new Error("spawn crashed"));

    await expect(run).resolves.toEqual({ ok: false, reason: "spawn-error", error: "spawn crashed" });
    expect(child.killed).toBe(true);
  });

  it("times out the login subprocess and kills the child", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const run = runCodexBrowserLogin({
        binary: "/bundled/codex",
        timeoutMs: 25,
        spawnFn: fakeSpawn(child),
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(run).resolves.toEqual({
        ok: false,
        reason: "timeout",
        error: "codex login timed out after 25ms",
      });
      expect(child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps a spawn throw to spawn-error", async () => {
    const throwingSpawn = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runCodexBrowserLogin({ binary: "/nope/codex", spawnFn: throwingSpawn });
    expect(outcome).toEqual({ ok: false, reason: "spawn-error", error: "ENOENT" });
  });
});
