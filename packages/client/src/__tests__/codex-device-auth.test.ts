import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DeviceCodePrompt,
  parseDeviceCodePrompt,
  runCodexDeviceAuthLogin,
  stripAnsi,
} from "../runtime/codex-device-auth.js";

const ESC = "";

/**
 * Faithful reproduction of the real codex-cli 0.130.0 `login --device-auth`
 * first screen (ANSI colour codes included), captured on a real machine.
 */
const REAL_DEVICE_AUTH_OUTPUT = [
  "",
  `Welcome to Codex [v${ESC}[90m0.130.0${ESC}[0m]`,
  `${ESC}[90mOpenAI's command-line coding agent${ESC}[0m`,
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  `   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m`,
  "",
  `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m`,
  `   ${ESC}[94m0WYJ-KDUHH${ESC}[0m`,
  "",
  `${ESC}[90mDevice codes are a common phishing target. Never share this code.${ESC}[0m`,
  "",
].join("\n");

describe("stripAnsi", () => {
  it("removes CSI colour escapes including the ESC byte", () => {
    expect(stripAnsi(`${ESC}[94mhello${ESC}[0m`)).toBe("hello");
  });

  it("is a noop on plain text", () => {
    expect(stripAnsi("plain text 0WYJ-KDUHH")).toBe("plain text 0WYJ-KDUHH");
  });
});

describe("parseDeviceCodePrompt", () => {
  it("extracts url + code + expiry from the real ANSI output, with no escape leakage", () => {
    const prompt = parseDeviceCodePrompt(REAL_DEVICE_AUTH_OUTPUT);
    expect(prompt).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "0WYJ-KDUHH",
      expiresInMinutes: 15,
    });
    // No ESC/control bytes leaked into the surfaced fields.
    expect(/[^\x21-\x7e]/.test(prompt?.verificationUrl ?? "")).toBe(false);
    expect(/[^\x21-\x7e]/.test(prompt?.userCode ?? "")).toBe(false);
  });

  it("accepts a 4-5 char code shape (0X6X-AHZKQ)", () => {
    expect(parseDeviceCodePrompt("https://x/device\n0X6X-AHZKQ")?.userCode).toBe("0X6X-AHZKQ");
  });

  it("returns null until BOTH url and code are present (partial buffer)", () => {
    expect(parseDeviceCodePrompt("...\n   https://auth.openai.com/codex/device\n")).toBeNull();
  });

  it("returns null on output with neither", () => {
    expect(parseDeviceCodePrompt("loading configuration...")).toBeNull();
  });

  it("does not mistake the dotted version string for a code", () => {
    expect(parseDeviceCodePrompt("Welcome to Codex [v0.130.0]\nhttps://x/device")).toBeNull();
  });

  it("omits expiry when the prompt does not state it", () => {
    const prompt = parseDeviceCodePrompt("https://x/device ABCD-EFGH");
    expect(prompt?.expiresInMinutes).toBeUndefined();
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

describe("runCodexDeviceAuthLogin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onDeviceCode once and resolves ok on exit 0", async () => {
    const child = new FakeChild();
    const prompts: DeviceCodePrompt[] = [];
    const run = runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: (p) => prompts.push(p),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout(REAL_DEVICE_AUTH_OUTPUT);
    child.emitStdout("\nSuccessfully logged in\n"); // further output must not re-fire
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.userCode).toBe("0WYJ-KDUHH");
  });

  it("fires once even when url and code arrive in separate chunks", async () => {
    const child = new FakeChild();
    const prompts: DeviceCodePrompt[] = [];
    const run = runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: (p) => prompts.push(p),
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout("   https://auth.openai.com/codex/device\n");
    expect(prompts).toHaveLength(0); // code not seen yet
    child.emitStdout("   0WYJ-KDUHH\n");
    child.close(0);

    await expect(run).resolves.toEqual({ ok: true });
    expect(prompts).toHaveLength(1);
  });

  it("reports no-prompt when it exits nonzero without ever surfacing a code", async () => {
    const child = new FakeChild();
    const run = runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: () => {},
      spawnFn: fakeSpawn(child),
    });

    child.emitStderr("Error loading configuration: bad config\n");
    child.close(1);

    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("no-prompt");
      expect(outcome.error).toContain("bad config");
    }
  });

  it("reports exit-nonzero when it dies after surfacing a code", async () => {
    const child = new FakeChild();
    const run = runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: () => {},
      spawnFn: fakeSpawn(child),
    });

    child.emitStdout(REAL_DEVICE_AUTH_OUTPUT);
    child.close(1);

    const outcome = await run;
    if (!outcome.ok) expect(outcome.reason).toBe("exit-nonzero");
    else throw new Error("expected failure");
  });

  it("resolves aborted and kills the child when the signal fires", async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const run = runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: () => {},
      signal: controller.signal,
      spawnFn: fakeSpawn(child),
    });

    controller.abort();
    const outcome = await run;
    expect(outcome).toEqual({ ok: false, reason: "aborted", error: "device-auth aborted by operator" });
    expect(child.killed).toBe(true);
  });

  it("resolves aborted immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: () => {},
      signal: controller.signal,
      spawnFn: fakeSpawn(new FakeChild()),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("aborted");
  });

  it("maps a spawn throw to spawn-error", async () => {
    const throwingSpawn = (() => {
      throw new Error("ENOENT");
    }) as unknown as typeof import("node:child_process").spawn;
    const outcome = await runCodexDeviceAuthLogin({
      binary: "/nope/codex",
      onDeviceCode: () => {},
      spawnFn: throwingSpawn,
    });
    expect(outcome).toEqual({ ok: false, reason: "spawn-error", error: "ENOENT" });
  });

  it("times out and kills the child past the ceiling", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const run = runCodexDeviceAuthLogin({
      binary: "/bundled/codex",
      onDeviceCode: () => {},
      timeoutMs: 1000,
      spawnFn: fakeSpawn(child),
    });
    await vi.advanceTimersByTimeAsync(1001);
    const outcome = await run;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("timeout");
    expect(child.killed).toBe(true);
  });
});
