import { describe, expect, it, vi } from "vitest";
import type { ClaudeExecutableResolution } from "../handlers/claude-executable.js";
import { classifyClaudeSmokeFailure, probeClaudeCodeCapability } from "../runtime/capabilities/claude-code.js";
import { parseTmuxVersion, probeClaudeCodeTuiCapability } from "../runtime/capabilities/claude-code-tui.js";
import {
  classifyDoctorReport,
  parseDoctorReport,
  probeCodexCapability,
  resolveBundledCodexBinary,
} from "../runtime/capabilities/codex.js";
import {
  type AuthPrecheckOutcome,
  commandFailureDigest,
  MAX_ERROR_LENGTH,
  type ResolveOutcome,
  runCommand,
  runLaunchProbe,
  type SmokeOutcome,
  truncateError,
  verifyLaunchable,
} from "../runtime/capabilities/launch-probe.js";

/**
 * Launch-verified capability probes — the contract under test:
 *
 *   - `ok` is reachable ONLY through the smoke stage (a real provider
 *     launch); resolve/auth-precheck failures short-circuit to
 *     `missing`/`unauthenticated` respectively.
 *   - every non-ok entry carries the provider's own error text verbatim
 *     (truncated to MAX_ERROR_LENGTH).
 *   - every launch-probe entry carries `probeKind: "launch"` + `latencyMs`
 *     so the server/web side can distinguish them from legacy static rows.
 *
 * All provider-probe tests inject the full dependency seam (resolve /
 * verify / precheck / smoke) so nothing here spawns a real provider,
 * touches the network, or spends tokens. The few real-spawn tests at the
 * bottom of the framework block use `node` itself (always present in the
 * test environment).
 */

const okResolve: ResolveOutcome & { ok: true } = { ok: true, binary: "/fake/bin", version: "1.2.3" };
const okAuth: AuthPrecheckOutcome & { ok: true } = { ok: true, method: "oauth" };

describe("runLaunchProbe (framework)", () => {
  it("resolve failure → missing, error verbatim, smoke never runs", async () => {
    const smoke = vi.fn<() => Promise<SmokeOutcome>>();
    const entry = await runLaunchProbe({
      resolve: async () => ({ ok: false, error: "`claude` at /x could not be executed (exit 126)" }),
      authPrecheck: async () => okAuth,
      smoke,
    });
    expect(entry).toMatchObject({
      state: "missing",
      available: false,
      authenticated: false,
      sdkVersion: null,
      authMethod: "none",
      error: "`claude` at /x could not be executed (exit 126)",
      probeKind: "launch",
    });
    expect(typeof entry.latencyMs).toBe("number");
    expect(smoke).not.toHaveBeenCalled();
  });

  it("auth precheck failure → unauthenticated with resolve-stage version, smoke never runs", async () => {
    const smoke = vi.fn<() => Promise<SmokeOutcome>>();
    const entry = await runLaunchProbe({
      resolve: async () => okResolve,
      authPrecheck: async () => ({ ok: false, error: "Not logged in" }),
      smoke,
    });
    expect(entry).toMatchObject({
      state: "unauthenticated",
      available: true,
      authenticated: false,
      sdkVersion: "1.2.3",
      authMethod: "none",
      error: "Not logged in",
    });
    expect(smoke).not.toHaveBeenCalled();
  });

  it("smoke ok → ok; method comes from the precheck, version from resolve", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => okResolve,
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "ok" }),
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      authenticated: true,
      sdkVersion: "1.2.3",
      authMethod: "oauth",
      probeKind: "launch",
    });
    expect(entry.degraded).toBeUndefined();
    expect(entry.error).toBeUndefined();
  });

  it("smoke may override version/method and flag degraded", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => okResolve,
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "ok", version: "9.9.9", method: "api_key", degraded: true }),
    });
    expect(entry.sdkVersion).toBe("9.9.9");
    expect(entry.authMethod).toBe("api_key");
    expect(entry.degraded).toBe(true);
  });

  it("smoke unauthenticated → unauthenticated with the provider's verbatim error", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => okResolve,
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "unauthenticated", error: "Invalid API key · Please run /login" }),
    });
    expect(entry).toMatchObject({
      state: "unauthenticated",
      available: true,
      authenticated: false,
      authMethod: "none",
      error: "Invalid API key · Please run /login",
    });
  });

  it("smoke missing → missing (e.g. the SDK's bundled binary is absent)", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => ({ ok: true, version: null }),
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "missing", error: "Native CLI binary for darwin-arm64 not found" }),
    });
    expect(entry).toMatchObject({ state: "missing", available: false, error: expect.stringContaining("not found") });
  });

  it("smoke error → error", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => okResolve,
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "error", error: "boom" }),
    });
    expect(entry).toMatchObject({ state: "error", available: false, error: "boom" });
  });

  it("a thrown stage becomes state=error (never throws)", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => {
        throw new Error("resolve blew up");
      },
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "ok" }),
    });
    expect(entry).toMatchObject({ state: "error", available: false, error: "resolve blew up" });
  });

  it("a non-Error throw is stringified", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => {
        throw "string failure";
      },
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "ok" }),
    });
    expect(entry.error).toBe("string failure");
  });

  it("caps stored error text at MAX_ERROR_LENGTH", async () => {
    const entry = await runLaunchProbe({
      resolve: async () => ({ ok: false, error: "x".repeat(2000) }),
      authPrecheck: async () => okAuth,
      smoke: async () => ({ state: "ok" }),
    });
    expect(entry.error).toHaveLength(MAX_ERROR_LENGTH + 1); // 500 chars + ellipsis
    expect(entry.error?.endsWith("…")).toBe(true);
  });
});

describe("truncateError / commandFailureDigest", () => {
  it("truncateError trims whitespace and keeps short text intact", () => {
    expect(truncateError("  hello \n")).toBe("hello");
  });

  it("digest prefers spawnError, then timeout, then stderr|stdout, then exit code", () => {
    const base = { ok: false, exitCode: 1, stdout: "", stderr: "", timedOut: false, durationMs: 5 };
    expect(commandFailureDigest("x", { ...base, spawnError: "ENOENT" })).toBe("x: ENOENT");
    expect(commandFailureDigest("x", { ...base, timedOut: true })).toBe("x: timed out after 5ms");
    expect(commandFailureDigest("x", { ...base, stderr: "err", stdout: "out" })).toBe("x: err | out");
    // claude prints auth errors on STDOUT — the digest must read both streams.
    expect(commandFailureDigest("x", { ...base, stdout: "Invalid API key · Please run /login" })).toBe(
      "x: Invalid API key · Please run /login",
    );
    expect(commandFailureDigest("x", base)).toBe("x: exited with code 1");
  });
});

describe("runCommand / verifyLaunchable (real node spawns)", () => {
  it("captures stdout and exit code from a real process", async () => {
    const res = await runCommand(process.execPath, ["-e", "console.log('hi')"], { timeoutMs: 15_000 });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });

  it("reports a spawn error for a nonexistent binary instead of throwing", async () => {
    const res = await runCommand("/definitely/not/a/binary", [], { timeoutMs: 5000 });
    expect(res.ok).toBe(false);
    expect(res.spawnError).toMatch(/ENOENT/);
  });

  it("kills and flags a process that exceeds the timeout", async () => {
    const res = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  it("verifyLaunchable extracts a version from a real `--version` run", async () => {
    const res = await verifyLaunchable("node", process.execPath);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it("verifyLaunchable fails with a labelled digest when the binary cannot run", async () => {
    const res = await verifyLaunchable("claude", "/definitely/not/claude");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("claude --version");
  });
});

describe("classifyClaudeSmokeFailure", () => {
  it("maps the verified invalid-API-key signature to unauthenticated", () => {
    const out = classifyClaudeSmokeFailure("Invalid API key · Please run /login");
    expect(out.state).toBe("unauthenticated");
    expect(out.error).toBe("Invalid API key · Please run /login");
  });

  it("maps the SDK's typed auth failure code to unauthenticated", () => {
    expect(classifyClaudeSmokeFailure("authentication_failed").state).toBe("unauthenticated");
    expect(classifyClaudeSmokeFailure("OAuth token expired").state).toBe("unauthenticated");
  });

  it("maps the SDK's missing-bundle throw to missing", () => {
    expect(classifyClaudeSmokeFailure("Native CLI binary for darwin-arm64 not found").state).toBe("missing");
    expect(classifyClaudeSmokeFailure("spawn claude ENOENT").state).toBe("missing");
  });

  it("anything else is an error carrying the verbatim text", () => {
    const out = classifyClaudeSmokeFailure("upstream 503");
    expect(out).toEqual({ state: "error", error: "upstream 503" });
  });

  it("empty text gets a placeholder instead of an empty error", () => {
    expect(classifyClaudeSmokeFailure("  ").error).toBe("smoke failed without output");
  });
});

describe("probeClaudeCodeCapability", () => {
  const onPath = (): ClaudeExecutableResolution => ({ path: "/usr/local/bin/claude", source: "path" });
  const bundledOnly = (): ClaudeExecutableResolution => ({ path: undefined, source: "default" });
  const verifyOk = async (): Promise<{ ok: true; version: string | null }> => ({ ok: true, version: "1.0.42" });
  const authed = () => ({ authenticated: true, method: "oauth" as const });
  const noAuth = () => ({ authenticated: false, method: "none" as const });
  const smokeOk = async (): Promise<SmokeOutcome> => ({ state: "ok" });

  it("`ok` only after a successful smoke; sdkVersion is the resolved CLI's real version", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath,
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke,
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      authenticated: true,
      authMethod: "oauth",
      sdkVersion: "1.0.42",
      probeKind: "launch",
    });
    // The smoke must target the binary the runtime would spawn.
    expect(runSmoke).toHaveBeenCalledWith("/usr/local/bin/claude");
  });

  it("no on-disk binary is NOT missing: SDK bundled path, version from the SDK package", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: bundledOnly,
      readSdkVersion: async () => "0.2.84",
      detectAuth: authed,
      runSmoke,
    });
    expect(entry.state).toBe("ok");
    expect(entry.sdkVersion).toBe("0.2.84");
    // undefined binary → the SDK uses its own bundled native binary.
    expect(runSmoke).toHaveBeenCalledWith(undefined);
  });

  it("`missing` when the SDK package fails to import", async () => {
    const entry = await probeClaudeCodeCapability({
      importSdk: async () => {
        throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
      },
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry).toMatchObject({ state: "missing", available: false, authenticated: false });
    expect(entry.error).toContain("Cannot find module");
  });

  it("`missing` when a resolved binary fails its real `--version` launch", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath,
      verifyBinary: async () => ({ ok: false, error: "claude --version: spawn EACCES" }),
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toBe("claude --version: spawn EACCES");
  });

  it("`unauthenticated` from the free precheck — no smoke is spent", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath,
      verifyBinary: verifyOk,
      detectAuth: noAuth,
      runSmoke,
    });
    expect(entry.state).toBe("unauthenticated");
    expect(entry.error).toContain("no Claude credentials found");
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it("a passing precheck does NOT yield ok — a failing smoke still wins", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath,
      verifyBinary: verifyOk,
      detectAuth: () => ({ authenticated: true, method: "api_key" as const }),
      runSmoke: async () => ({ state: "unauthenticated", error: "Invalid API key · Please run /login" }),
    });
    expect(entry.state).toBe("unauthenticated");
    expect(entry.error).toBe("Invalid API key · Please run /login");
  });

  it("smoke error text is truncated", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath,
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke: async () => ({ state: "error", error: "y".repeat(5000) }),
    });
    expect(entry.error).toHaveLength(MAX_ERROR_LENGTH + 1);
  });
});

describe("probeClaudeCodeTuiCapability", () => {
  const onPath = (): ClaudeExecutableResolution => ({ path: "/usr/local/bin/claude", source: "path" });
  const notOnPath = (): ClaudeExecutableResolution => ({ path: undefined, source: "default" });
  const tmux34 = () => ({ raw: "tmux 3.4", major: 3, minor: 4 });
  const verifyOk = async (): Promise<{ ok: true; version: string | null }> => ({ ok: true, version: "1.0.42" });
  const authed = () => ({ authenticated: true, method: "oauth" as const });
  const noAuth = () => ({ authenticated: false, method: "none" as const });
  const smokeOk = async (): Promise<SmokeOutcome> => ({ state: "ok" });

  it("`ok` when claude launches, tmux >= 3.0, and the headless smoke passes", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: tmux34,
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke,
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      authenticated: true,
      authMethod: "oauth",
      // sdkVersion carries the claude CLI version (the runtime engine), not tmux.
      sdkVersion: "1.0.42",
      probeKind: "launch",
    });
    expect(runSmoke).toHaveBeenCalledWith("/usr/local/bin/claude");
  });

  it("`unauthenticated` when claude + tmux are present but not logged in (no smoke spent)", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: tmux34,
      verifyBinary: verifyOk,
      detectAuth: noAuth,
      runSmoke,
    });
    expect(entry).toMatchObject({ state: "unauthenticated", available: true, authenticated: false });
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it("`missing` when claude resolves only to the SDK bundle (source=default)", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: notOnPath,
      probeTmux: tmux34,
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("missing");
    expect(entry.available).toBe(false);
    expect(entry.error).toContain("`claude` not found");
  });

  it("`missing` when claude resolves but its real `--version` launch fails", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: tmux34,
      verifyBinary: async () => ({ ok: false, error: "claude --version: exited with code 126" }),
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("could not be executed");
    expect(entry.sdkVersion).toBeNull();
  });

  it("`missing` when tmux is absent", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: () => null,
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("tmux not found");
  });

  it("`missing` when tmux is older than 3.0", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: () => ({ raw: "tmux 2.9", major: 2, minor: 9 }),
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("older than 3.0");
  });

  it("accepts tmux 3.0 exactly (boundary)", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: () => ({ raw: "tmux 3.0", major: 3, minor: 0 }),
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("ok");
  });

  it("accepts a future major (e.g. tmux 4.0)", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: () => ({ raw: "tmux 4.0", major: 4, minor: 0 }),
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("ok");
  });

  it("reports both missing reasons when claude and tmux are absent", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: notOnPath,
      probeTmux: () => null,
      detectAuth: authed,
      runSmoke: smokeOk,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("`claude` not found");
    expect(entry.error).toContain("tmux not found");
  });

  it("a failing headless smoke classifies like the SDK smoke (auth signature → unauthenticated)", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      probeTmux: tmux34,
      verifyBinary: verifyOk,
      detectAuth: authed,
      runSmoke: async () => ({
        state: "unauthenticated",
        error: "`claude -p` smoke: Invalid API key · Please run /login",
      }),
    });
    expect(entry.state).toBe("unauthenticated");
    expect(entry.error).toContain("Invalid API key");
  });

  it("surfaces a thrown dependency as state=error", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: () => {
        throw new Error("resolve blew up");
      },
    });
    expect(entry.state).toBe("error");
    expect(entry.available).toBe(false);
    expect(entry.error).toBe("resolve blew up");
  });
});

describe("parseTmuxVersion", () => {
  it("parses plain `tmux 3.4`", () => {
    expect(parseTmuxVersion("tmux 3.4")).toMatchObject({ major: 3, minor: 4 });
  });

  it("parses a letter-suffixed patch release `tmux 3.2a`", () => {
    expect(parseTmuxVersion("tmux 3.2a")).toMatchObject({ major: 3, minor: 2 });
  });

  it("parses a pre-release build `tmux next-3.5`", () => {
    expect(parseTmuxVersion("tmux next-3.5")).toMatchObject({ major: 3, minor: 5 });
  });

  it("trims trailing whitespace/newline into `raw`", () => {
    expect(parseTmuxVersion("tmux 3.4\n")?.raw).toBe("tmux 3.4");
  });

  it("returns null when no version is present", () => {
    expect(parseTmuxVersion("tmux: command not found")).toBeNull();
  });
});

/**
 * Fixtures mirror real `codex doctor --json` (schemaVersion 1) captures from
 * a live binary in all three auth states; only fields the classifier reads
 * are kept. The 401 text lives in `details["handshake transport error"]` of
 * the websocket check — auth.credentials stays `ok` because the (invalid)
 * key file exists.
 */
const DOCTOR_LOGGED_IN = JSON.stringify({
  schemaVersion: 1,
  codexVersion: "0.134.0",
  overallStatus: "warning", // unrelated warning (update check) — must be ignored
  checks: {
    "auth.credentials": { status: "ok", summary: "found ChatGPT credentials", remediation: null, details: {} },
    "network.websocket_reachability": {
      status: "ok",
      summary: "Responses WebSocket handshake succeeded",
      remediation: null,
      details: {},
    },
  },
});

const DOCTOR_NO_CREDS = JSON.stringify({
  schemaVersion: 1,
  codexVersion: "0.134.0",
  overallStatus: "fail",
  checks: {
    "auth.credentials": {
      status: "fail",
      summary: "no Codex credentials were found",
      remediation: "run `codex login`",
      details: {},
    },
  },
});

const DOCTOR_BAD_KEY = JSON.stringify({
  schemaVersion: 1,
  codexVersion: "0.134.0",
  overallStatus: "warning",
  checks: {
    "auth.credentials": { status: "ok", summary: "found API key credentials", remediation: null, details: {} },
    "network.websocket_reachability": {
      status: "warning",
      summary: "Responses WebSocket handshake failed",
      remediation: "check your credentials",
      details: { "handshake transport error": 'http 401 Unauthorized: Some("")' },
    },
  },
});

describe("parseDoctorReport / classifyDoctorReport", () => {
  it("parses a real-shaped report", () => {
    const report = parseDoctorReport(DOCTOR_LOGGED_IN);
    expect(report?.codexVersion).toBe("0.134.0");
    expect(report?.checks["auth.credentials"]?.status).toBe("ok");
  });

  it("returns null for non-JSON / wrong-shape payloads", () => {
    expect(parseDoctorReport("not json")).toBeNull();
    expect(parseDoctorReport('"just a string"')).toBeNull();
    expect(parseDoctorReport('{"noChecks": true}')).toBeNull();
  });

  it("logged-in report → ok (overallStatus warnings are ignored)", () => {
    const report = parseDoctorReport(DOCTOR_LOGGED_IN);
    if (!report) throw new Error("fixture failed to parse");
    expect(classifyDoctorReport(report)).toEqual({ state: "ok", version: "0.134.0" });
  });

  it("no-credentials report → unauthenticated with summary + remediation", () => {
    const report = parseDoctorReport(DOCTOR_NO_CREDS);
    if (!report) throw new Error("fixture failed to parse");
    const out = classifyDoctorReport(report);
    expect(out.state).toBe("unauthenticated");
    expect(out.error).toBe("no Codex credentials were found (run `codex login`)");
  });

  it("invalid-key report → unauthenticated carrying the verbatim 401 transport error", () => {
    const report = parseDoctorReport(DOCTOR_BAD_KEY);
    if (!report) throw new Error("fixture failed to parse");
    const out = classifyDoctorReport(report);
    expect(out.state).toBe("unauthenticated");
    expect(out.error).toContain('http 401 Unauthorized: Some("")');
  });

  it("non-auth handshake failure → error with the verbatim detail", () => {
    const report = parseDoctorReport(
      JSON.stringify({
        codexVersion: "0.134.0",
        checks: {
          "auth.credentials": { status: "ok", summary: "found", remediation: null, details: {} },
          "network.websocket_reachability": {
            status: "warning",
            summary: "Responses WebSocket handshake failed",
            remediation: null,
            details: { "handshake transport error": "connection refused" },
          },
        },
      }),
    );
    if (!report) throw new Error("fixture failed to parse");
    const out = classifyDoctorReport(report);
    expect(out.state).toBe("error");
    expect(out.error).toBe("Responses WebSocket handshake failed: connection refused");
  });

  it("a future doctor without the websocket check degrades instead of failing", () => {
    const report = parseDoctorReport(
      JSON.stringify({
        codexVersion: "1.0.0",
        checks: { "auth.credentials": { status: "ok", summary: "found", remediation: null, details: {} } },
      }),
    );
    if (!report) throw new Error("fixture failed to parse");
    expect(classifyDoctorReport(report)).toEqual({ state: "ok", degraded: true, version: "1.0.0" });
  });
});

describe("probeCodexCapability", () => {
  const located = async (): Promise<{ ok: true; binary: string }> => ({ ok: true, binary: "/vendor/bin/codex" });
  const verifyOk = async (): Promise<{ ok: true; version: string | null }> => ({ ok: true, version: "0.134.0" });
  const loggedIn = async (): Promise<AuthPrecheckOutcome> => ({ ok: true, method: "auth_json" });
  const smokeOk = async (): Promise<SmokeOutcome> => ({ state: "ok", version: "0.134.0" });

  it("`ok` only after the doctor smoke; binary is the SDK's bundled vendor binary", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeCodexCapability({
      resolveBinary: located,
      verifyBinary: verifyOk,
      loginStatus: loggedIn,
      runSmoke,
      env: {},
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      authenticated: true,
      authMethod: "auth_json",
      sdkVersion: "0.134.0",
      probeKind: "launch",
    });
    expect(runSmoke).toHaveBeenCalledWith("/vendor/bin/codex");
  });

  it("`missing` when the bundled binary cannot be located, with the chain's own error", async () => {
    const entry = await probeCodexCapability({
      resolveBinary: async () => ({ ok: false, error: "@openai/codex-sdk failed to resolve: not installed" }),
      env: {},
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("@openai/codex-sdk failed to resolve");
  });

  it("`missing` when the located binary fails its real `--version` launch", async () => {
    const entry = await probeCodexCapability({
      resolveBinary: located,
      verifyBinary: async () => ({ ok: false, error: "codex --version: spawn EACCES" }),
      env: {},
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toBe("codex --version: spawn EACCES");
  });

  it("`unauthenticated` when `codex login status` fails — no smoke spent", async () => {
    const runSmoke = vi.fn(smokeOk);
    const entry = await probeCodexCapability({
      resolveBinary: located,
      verifyBinary: verifyOk,
      loginStatus: async () => ({ ok: false, error: "`codex login status`: Not logged in" }),
      runSmoke,
      env: {},
    });
    expect(entry.state).toBe("unauthenticated");
    expect(entry.error).toContain("Not logged in");
    expect(runSmoke).not.toHaveBeenCalled();
  });

  it("CODEX_API_KEY short-circuits the login-status precheck (api_key method)", async () => {
    const loginStatus = vi.fn(loggedIn);
    const entry = await probeCodexCapability({
      resolveBinary: located,
      verifyBinary: verifyOk,
      loginStatus,
      runSmoke: smokeOk,
      env: { CODEX_API_KEY: "ck-test" },
    });
    expect(entry.state).toBe("ok");
    expect(entry.authMethod).toBe("api_key");
    expect(loginStatus).not.toHaveBeenCalled();
  });

  it("a logged-in precheck does NOT yield ok — the doctor's 401 still wins", async () => {
    const entry = await probeCodexCapability({
      resolveBinary: located,
      verifyBinary: verifyOk,
      loginStatus: loggedIn,
      runSmoke: async () => ({
        state: "unauthenticated",
        error: 'Responses WebSocket handshake failed: http 401 Unauthorized: Some("")',
      }),
      env: {},
    });
    expect(entry.state).toBe("unauthenticated");
    expect(entry.error).toContain("401 Unauthorized");
  });

  it("an old codex without `doctor` degrades to a weaker ok instead of failing", async () => {
    const entry = await probeCodexCapability({
      resolveBinary: located,
      verifyBinary: verifyOk,
      loginStatus: loggedIn,
      runSmoke: async () => ({ state: "ok", degraded: true }),
      env: {},
    });
    expect(entry.state).toBe("ok");
    expect(entry.degraded).toBe(true);
    expect(entry.sdkVersion).toBe("0.134.0"); // falls back to the resolve-stage version
  });
});

describe("resolveBundledCodexBinary (real node_modules)", () => {
  it("replays the SDK's resolution chain to an existing vendor binary", async () => {
    // The repo depends on @openai/codex-sdk with optional platform packages,
    // so on any supported dev/CI machine the chain should land on a real file.
    const res = await resolveBundledCodexBinary();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.binary).toMatch(/[/\\]codex(\.exe)?$/);
  });
});

describe("probeCapabilities (aggregator)", () => {
  it("returns one entry per built-in provider (probes mocked — no real launches)", async () => {
    vi.resetModules();
    const fakeEntry = (state: "ok" | "missing") => ({
      state,
      available: state === "ok",
      authenticated: state === "ok",
      sdkVersion: null,
      authMethod: "none",
      detectedAt: new Date().toISOString(),
      probeKind: "launch",
      latencyMs: 1,
    });
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({
      probeClaudeCodeCapability: vi.fn().mockResolvedValue(fakeEntry("ok")),
    }));
    vi.doMock("../runtime/capabilities/claude-code-tui.js", () => ({
      probeClaudeCodeTuiCapability: vi.fn().mockResolvedValue(fakeEntry("missing")),
    }));
    vi.doMock("../runtime/capabilities/codex.js", () => ({
      probeCodexCapability: vi.fn().mockResolvedValue(fakeEntry("ok")),
    }));
    const mod = await import("../runtime/capabilities/index.js");

    const caps = await mod.probeCapabilities();

    expect(Object.keys(caps).sort()).toEqual(["claude-code", "claude-code-tui", "codex"]);
    expect(caps["claude-code"]?.state).toBe("ok");
    expect(caps["claude-code-tui"]?.state).toBe("missing");
    expect(caps.codex?.state).toBe("ok");

    vi.doUnmock("../runtime/capabilities/claude-code.js");
    vi.doUnmock("../runtime/capabilities/claude-code-tui.js");
    vi.doUnmock("../runtime/capabilities/codex.js");
    vi.resetModules();
  });

  it("converts provider probe rejections into error capability entries", async () => {
    vi.resetModules();
    vi.doMock("../runtime/capabilities/claude-code.js", () => ({
      probeClaudeCodeCapability: vi.fn().mockRejectedValue(new Error("claude probe failed")),
    }));
    vi.doMock("../runtime/capabilities/codex.js", () => ({
      probeCodexCapability: vi.fn().mockRejectedValue("codex probe failed"),
    }));
    vi.doMock("../runtime/capabilities/claude-code-tui.js", () => ({
      probeClaudeCodeTuiCapability: vi.fn().mockRejectedValue("tui probe failed"),
    }));
    const mod = await import("../runtime/capabilities/index.js");

    const caps = await mod.probeCapabilities();

    expect(caps["claude-code"]).toMatchObject({
      state: "error",
      available: false,
      authenticated: false,
      authMethod: "none",
      error: "claude probe failed",
    });
    expect(caps.codex).toMatchObject({ state: "error", error: "codex probe failed" });
    expect(caps["claude-code-tui"]).toMatchObject({ state: "error", error: "tui probe failed" });

    vi.doUnmock("../runtime/capabilities/claude-code.js");
    vi.doUnmock("../runtime/capabilities/codex.js");
    vi.doUnmock("../runtime/capabilities/claude-code-tui.js");
    vi.resetModules();
  });
});
