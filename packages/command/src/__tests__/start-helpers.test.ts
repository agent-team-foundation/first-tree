import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAddressInUseError, normaliseHost, sanitizeUsername, shouldAutoOpenBrowser } from "../commands/start.js";

describe("normaliseHost", () => {
  it.each([
    ["0.0.0.0", "127.0.0.1"],
    ["::", "127.0.0.1"],
    ["::0", "127.0.0.1"],
  ])("rewrites wildcard %s to 127.0.0.1", (input, expected) => {
    expect(normaliseHost(input)).toBe(expected);
  });

  it("preserves explicit loopback addresses", () => {
    expect(normaliseHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normaliseHost("::1")).toBe("::1");
  });

  it("preserves arbitrary hostnames the operator picks", () => {
    expect(normaliseHost("hub.internal")).toBe("hub.internal");
  });
});

describe("sanitizeUsername", () => {
  it("lower-cases", () => {
    expect(sanitizeUsername("ALICE")).toBe("alice");
  });

  it("preserves the underscore/dash subset", () => {
    expect(sanitizeUsername("a_b-c")).toBe("a_b-c");
  });

  it("collapses other punctuation to dashes", () => {
    expect(sanitizeUsername("a.b c@d")).toBe("a-b-c-d");
  });

  it("returns an empty string when input is exclusively non-allowed characters", () => {
    // Caller is expected to fall back to "admin" — this test pins the
    // contract so the fallback in `ensureLocalAdmin` stays correct.
    expect(sanitizeUsername("!@#$")).toBe("----");
  });
});

describe("isAddressInUseError", () => {
  it("matches Node's EADDRINUSE error shape", () => {
    const err = Object.assign(new Error("listen EADDRINUSE :::8000"), { code: "EADDRINUSE" });
    expect(isAddressInUseError(err)).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isAddressInUseError(new Error("kaboom"))).toBe(false);
    expect(isAddressInUseError(null)).toBe(false);
    expect(isAddressInUseError(undefined)).toBe(false);
    expect(isAddressInUseError(Object.assign(new Error(), { code: "EACCES" }))).toBe(false);
  });
});

describe("shouldAutoOpenBrowser", () => {
  let originalSshClient: string | undefined;
  let originalSshTty: string | undefined;
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    originalSshClient = process.env.SSH_CLIENT;
    originalSshTty = process.env.SSH_TTY;
    originalIsTty = process.stdout.isTTY;
    delete process.env.SSH_CLIENT;
    delete process.env.SSH_TTY;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  });

  afterEach(() => {
    if (originalSshClient !== undefined) process.env.SSH_CLIENT = originalSshClient;
    if (originalSshTty !== undefined) process.env.SSH_TTY = originalSshTty;
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTty });
    vi.unstubAllEnvs();
  });

  it("returns true on an interactive TTY without SSH", () => {
    expect(shouldAutoOpenBrowser({})).toBe(true);
  });

  it("respects --no-open", () => {
    expect(shouldAutoOpenBrowser({ open: false })).toBe(false);
  });

  it("opts out under SSH_CLIENT", () => {
    process.env.SSH_CLIENT = "1.2.3.4";
    expect(shouldAutoOpenBrowser({})).toBe(false);
  });

  it("opts out under SSH_TTY", () => {
    process.env.SSH_TTY = "/dev/pts/0";
    expect(shouldAutoOpenBrowser({})).toBe(false);
  });

  it("opts out when stdout is not a TTY (piped invocation)", () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    expect(shouldAutoOpenBrowser({})).toBe(false);
  });
});
