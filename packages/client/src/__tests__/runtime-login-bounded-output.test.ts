import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { AUTH_URL_TOKEN_MAX, createAuthUrlScanner, LOGIN_STDERR_TAIL_MAX } from "../providers/runtime-login.js";
import { runCodexBrowserLogin } from "../runtime/codex-login.js";

/**
 * Regression cover for #1720: a provider login may stream for the full
 * five-minute browser-OAuth window, so neither the retained state nor the
 * scanning work may grow with the volume of output.
 */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(): boolean {
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

function fakeSpawn(child: FakeChild): typeof import("node:child_process").spawn {
  return (() => child) as unknown as typeof import("node:child_process").spawn;
}

describe("auth URL scanner keeps retained state bounded", () => {
  it("retains nothing beyond the current partial token across a flood of chunks", () => {
    const scanner = createAuthUrlScanner();
    for (let i = 0; i < 5_000; i++) {
      expect(scanner.push(`waiting for sign-in chunk ${i} `)).toBeNull();
      expect(scanner.retainedChars()).toBe(0);
    }
  });

  it("caps an over-long unterminated token instead of growing without bound", () => {
    const scanner = createAuthUrlScanner();
    // A single 200 KB run of non-whitespace: retention must stay at the cap.
    for (let i = 0; i < 200; i++) {
      scanner.push("x".repeat(1_000));
      expect(scanner.retainedChars()).toBeLessThanOrEqual(AUTH_URL_TOKEN_MAX);
    }
    // The discarded token must not poison the next, real one.
    scanner.push(" https://auth.openai.com/ok\n");
    expect(scanner.retainedChars()).toBe(0);
  });

  it("skips a token that only exceeds the cap once its chunks are joined", () => {
    const scanner = createAuthUrlScanner();
    // Each piece fits on its own, so the cap has to be judged on the completed
    // token: otherwise a 2 KB carry plus a short segment is concatenated and
    // parsed, and an over-long "URL" is handed to the browser.
    scanner.push(`https://auth.example/${"a".repeat(2_000)}`);
    expect(scanner.retainedChars()).toBeLessThanOrEqual(AUTH_URL_TOKEN_MAX);
    expect(scanner.push(`${"b".repeat(100)} still waiting\n`)).toBeNull();
    expect(scanner.retainedChars()).toBeLessThanOrEqual(AUTH_URL_TOKEN_MAX);

    // The oversized token must not swallow what follows it.
    expect(scanner.push("visit https://auth.example/ok\n")).toBe("https://auth.example/ok");
  });

  it("skips a single over-long token without letting it hide a later URL in the same chunk", () => {
    const scanner = createAuthUrlScanner();
    const scannedBefore = scanner.scannedChars();
    const chunk = `https://auth.example/${"z".repeat(3_000)} then https://auth.example/real\n`;
    expect(scanner.push(chunk)).toBe("https://auth.example/real");
    expect(scanner.retainedChars()).toBe(0);
    expect(scanner.scannedChars()).toBe(scannedBefore + chunk.length);
  });

  it("recognises a URL split across chunk boundaries", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("If it didn't open, visit https://auth.open")).toBeNull();
    expect(scanner.push("ai.com/oauth/authorize?x=1")).toBeNull();
    expect(scanner.push("\nnext line\n")).toBe("https://auth.openai.com/oauth/authorize?x=1");
  });

  it("still skips the CLI's own loopback callback server", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("Starting local login server on http://localhost:1455.\n")).toBeNull();
    expect(scanner.push("listening on http://127.0.0.1:1455\n")).toBeNull();
    expect(scanner.push("visit https://auth.openai.com/x\n")).toBe("https://auth.openai.com/x");
  });

  it("stops scanning, stops growing and stops reporting once a URL is found", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("visit https://auth.openai.com/x\n")).toBe("https://auth.openai.com/x");
    const scannedAtHit = scanner.scannedChars();
    for (let i = 0; i < 1_000; i++) {
      expect(scanner.push(`https://auth.example/later-${i} and a very long unterminated tail`)).toBeNull();
      expect(scanner.retainedChars()).toBe(0);
    }
    expect(scanner.scannedChars()).toBe(scannedAtHit);
  });

  it("examines a large stream once, not once per accumulated buffer", () => {
    // Roughly 4 MB with no URL. Re-splitting the accumulated buffer on every
    // chunk would examine tens of GB here; an incremental parser examines each
    // character exactly once, which the scan counter asserts directly rather
    // than inferring it from how fast the test ran.
    const scanner = createAuthUrlScanner();
    const chunk = `${"provider chatter ".repeat(12)}\n`;
    const chunks = 20_000;
    for (let i = 0; i < chunks; i++) scanner.push(chunk);
    expect(scanner.scannedChars()).toBe(chunk.length * chunks);
    expect(scanner.retainedChars()).toBe(0);
  });
});

describe("auth URL scanner rejects a candidate that carries its own auth material", () => {
  // The published fallback link is a structured field, not error text, so it
  // never goes through `redactErrorPreview` (see runtime-auth-login.ts) β€” this
  // candidacy check is the only gate standing between a credential-shaped
  // string in provider output and a rendered "sign in" link.
  it("skips URL userinfo and finds the legitimate sign-in URL that follows", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("proxying through https://user:hunter2pwd@proxy.example/\n")).toBeNull();
    expect(scanner.push("now visit https://auth.openai.com/oauth/authorize?x=1\n")).toBe(
      "https://auth.openai.com/oauth/authorize?x=1",
    );
  });

  it("skips a credential-bearing query parameter and finds a later legitimate URL", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("debug callback https://auth.example/cb?access_token=abc123def456\n")).toBeNull();
    expect(scanner.push("sign in at https://auth.openai.com/oauth/authorize?client_id=cli\n")).toBe(
      "https://auth.openai.com/oauth/authorize?client_id=cli",
    );
  });

  it("does not treat an ordinary OAuth authorize query string as credential-bearing", () => {
    // client_id / redirect_uri / state / scope / code_challenge are normal
    // parts of an authorization URL and must not be mistaken for the
    // credential-key set (in particular `client_id` must not match
    // `client_secret`'s pattern).
    const scanner = createAuthUrlScanner();
    const url =
      "https://auth.openai.com/oauth/authorize?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455&state=xyz&scope=openid";
    expect(scanner.push(`${url}\n`)).toBe(url);
  });

  it("rejects a single-component userinfo token (bare `<token>@host`) the same way", () => {
    const scanner = createAuthUrlScanner();
    expect(scanner.push("cached at https://ghp_abcdef1234567890@raw.githubusercontent.com/x\n")).toBeNull();
    expect(scanner.push("visit https://auth.openai.com/oauth?x=1\n")).toBe("https://auth.openai.com/oauth?x=1");
  });

  it("rejects a credential in a URL fragment, which has no query params at all", () => {
    // A #fragment has no searchParams, so a check scoped to query-string keys
    // misses this shape entirely even though redactErrorPreview's key=value
    // rule (which does not care about URL syntax) still matches it.
    const scanner = createAuthUrlScanner();
    expect(scanner.push("stray redirect echo https://auth.example/#access_token=abc123def456\n")).toBeNull();
    expect(scanner.push("sign in at https://auth.openai.com/oauth/authorize?client_id=cli\n")).toBe(
      "https://auth.openai.com/oauth/authorize?client_id=cli",
    );
  });

  it("rejects a vendor-prefixed token sitting under a neutral query key", () => {
    // `context` is not a credential-shaped key name, so a check scoped to
    // credential-NAMED keys misses this: the value itself is a GitHub PAT
    // shape, which redactErrorPreview's vendor-token rule catches regardless
    // of what key it is assigned to.
    const scanner = createAuthUrlScanner();
    expect(
      scanner.push("callback https://auth.example/?context=ghp_AbCdEf0123456789abcdef0123456789abcd\n"),
    ).toBeNull();
    expect(scanner.push("sign in at https://auth.openai.com/oauth/authorize?client_id=cli\n")).toBe(
      "https://auth.openai.com/oauth/authorize?client_id=cli",
    );
  });
});

describe("runBrowserLogin does not retain the provider's output", () => {
  it("reports a cross-chunk external URL exactly once while streaming every chunk", async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const raw: string[] = [];
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      onAuthUrl: (u) => urls.push(u),
      onRawOutput: (chunk) => raw.push(chunk),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout("Starting local login server on http://localhost:1455.\n");
    child.emitStdout("If it didn't open, visit https://auth.open");
    child.emitStdout("ai.com/oauth?x=1\n");
    for (let i = 0; i < 500; i++) child.emitStdout(`still waiting ${i} https://auth.example/other-${i}\n`);
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://auth.openai.com/oauth?x=1"]);
    // Chunks keep streaming to the diagnostic hook; the login itself keeps none.
    expect(raw).toHaveLength(503);
  });

  it("never fires a credential-bearing stderr URL as the fallback link, even when it precedes the real one", async () => {
    const child = new FakeChild();
    const urls: string[] = [];
    const run = runCodexBrowserLogin({
      binary: "/bundled/codex",
      onAuthUrl: (u) => urls.push(u),
      spawnFn: fakeSpawn(child),
    });

    child.emitStderr("proxying through https://user:hunter2pwd@proxy.example/\n");
    child.emitStdout("If it didn't open, visit https://auth.openai.com/oauth?x=1\n");
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(urls).toEqual(["https://auth.openai.com/oauth?x=1"]);
  });

  it("keeps only a bounded stderr tail in the failure message", async () => {
    const child = new FakeChild();
    const run = runCodexBrowserLogin({ binary: "/bundled/codex", spawnFn: fakeSpawn(child) });

    for (let i = 0; i < 200; i++) child.emitStderr(`noisy provider diagnostic line ${i}\n`);
    child.emitStderr("could not open a browser on this host\n");
    child.close(1);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.length).toBeLessThanOrEqual(LOGIN_STDERR_TAIL_MAX);
    expect(outcome.error).toContain("could not open a browser on this host");
  });
});
