import { existsSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityEntry, CapabilityRuntimeSource } from "@first-tree/shared";
import { smokeCodexAppServer } from "../../handlers/codex/app-server/client.js";
import {
  type CodexExecutableVerification,
  findCodexExecutableOnPath,
  formatCodexBinaryMissingMessage,
  verifyCodexExecutable,
} from "../codex-binary.js";
import {
  type AuthPrecheckOutcome,
  commandFailureDigest,
  type ResolveOutcome,
  runCommand,
  runLaunchProbe,
  type SmokeOutcome,
  verifyLaunchable,
} from "./launch-probe.js";

/** `codex doctor` performs a real authenticated network roundtrip — give it room. */
export const CODEX_DOCTOR_TIMEOUT_MS = 60_000;

/**
 * Platform-package map mirrored from `@openai/codex-sdk`'s own binary
 * resolution (src/exec.ts). The probe must launch the SAME binary the runtime
 * spawns — the handler prefers the SDK-bundled vendor binary and only falls
 * back to a system `codex` on PATH when the bundle is missing.
 */
const CODEX_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function codexTargetTriple(): string | null {
  const { platform, arch } = process;
  if (platform === "linux") {
    return arch === "x64" ? "x86_64-unknown-linux-musl" : arch === "arm64" ? "aarch64-unknown-linux-musl" : null;
  }
  if (platform === "darwin") {
    return arch === "x64" ? "x86_64-apple-darwin" : arch === "arm64" ? "aarch64-apple-darwin" : null;
  }
  if (platform === "win32") {
    return arch === "x64" ? "x86_64-pc-windows-msvc" : arch === "arm64" ? "aarch64-pc-windows-msvc" : null;
  }
  return null;
}

/**
 * Find a file inside the installed `@openai/codex-sdk` package to anchor
 * `createRequire` resolution on. Vite SSR (vitest) strips
 * `import.meta.resolve`, so when it is unavailable we walk parent
 * `node_modules` to the same package instead — realpath'd so pnpm symlinks
 * resolve exactly like Node's own (symlink-following) resolution would.
 */
function locateCodexSdkAnchor(): string {
  if (typeof import.meta.resolve === "function") {
    return fileURLToPath(import.meta.resolve("@openai/codex-sdk"));
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, "node_modules", "@openai", "codex-sdk", "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("not found in any parent node_modules");
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Replicate the codex-sdk's own `resolveNativePackage` EXACTLY (dist/index.js):
 * the modern layout is used only when BOTH `bin/<codex>` and the
 * `codex-package.json` marker are present; otherwise the legacy
 * `codex/<codex>` layout. Returns null when neither resolves — which is
 * precisely when `new Codex()` throws "Unable to locate Codex CLI binaries"
 * and the handler falls back to a system PATH codex.
 *
 * Matching the marker check (not just `existsSync(bin/codex)`) keeps the probe
 * and the runtime on one binary-resolution contract: a partial install with
 * the binary present but the marker missing is NOT reported as bundled,
 * because the SDK would not spawn it either.
 */
export function resolveBundledBinaryInPackageRoot(packageRoot: string): string | null {
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
  const modernPath = join(packageRoot, "bin", binaryName);
  if (isFile(modernPath) && isFile(join(packageRoot, "codex-package.json"))) return modernPath;
  const legacyPath = join(packageRoot, "codex", binaryName);
  if (isFile(legacyPath)) return legacyPath;
  return null;
}

/**
 * Locate the bundled codex binary by replaying the SDK's resolution chain:
 * `@openai/codex-sdk` → its `@openai/codex` dep → the per-platform vendor
 * package → vendor root, then the SDK's own `resolveNativePackage` layout
 * check. Errors describe which link of the chain broke.
 */
export async function resolveBundledCodexBinary(): Promise<
  { ok: true; binary: string } | { ok: false; error: string }
> {
  const triple = codexTargetTriple();
  if (!triple) {
    return { ok: false, error: `unsupported platform for codex: ${process.platform} (${process.arch})` };
  }
  const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPackage) return { ok: false, error: `no codex platform package for ${triple}` };

  let sdkEntryPath: string;
  try {
    sdkEntryPath = locateCodexSdkAnchor();
  } catch (err) {
    return {
      ok: false,
      error: `@openai/codex-sdk failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let vendorRoot: string;
  try {
    const sdkRequire = createRequire(sdkEntryPath);
    const codexPackageJsonPath = sdkRequire.resolve("@openai/codex/package.json");
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    vendorRoot = join(dirname(platformPackageJsonPath), "vendor");
  } catch (err) {
    return {
      ok: false,
      error: `unable to locate codex CLI binaries (is @openai/codex installed with optional dependencies?): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const packageRoot = join(vendorRoot, triple);
  const binary = resolveBundledBinaryInPackageRoot(packageRoot);
  if (binary) return { ok: true, binary };
  return {
    ok: false,
    error: `codex binary not found under ${packageRoot} (need bin/codex + codex-package.json marker, or legacy codex/codex)`,
  };
}

/** Resolved runtime binary + provenance — mirrors the handler's bundled-first,
 * system-PATH-fallback order (PR #1054 `codex-binary.ts`). */
export type CodexBinaryResolution =
  | {
      ok: true;
      binary: string;
      runtimeSource: CapabilityRuntimeSource;
      runtimePath: string | null;
      version: string | null;
    }
  | { ok: false; error: string };

/** Injectable seams for `resolveCodexRuntimeBinary` (tests only). */
export type CodexRuntimeResolveDeps = {
  resolveBundled?: () => Promise<{ ok: true; binary: string } | { ok: false; error: string }>;
  verifyBundled?: (binary: string) => Promise<{ ok: true; version: string | null } | { ok: false; error: string }>;
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  verifyPath?: (path: string, env?: Record<string, string | undefined>) => CodexExecutableVerification;
};

/**
 * Resolve the codex binary the runtime would actually spawn, on the SAME
 * contract as the handler (`createCodexClientWithBinaryFallback`):
 *
 *   - bundled vendor binary present (per the SDK's own `resolveNativePackage`
 *     layout check) → launch-verify it. Launchable → that binary,
 *     `runtimeSource: "bundled"`. Present but NONLAUNCHABLE → resolve failure
 *     (→ `missing`): NOT a PATH fallback (the handler resolves to this same
 *     bundled binary, never a system codex once the bundle is found), and NOT
 *     left for the auth precheck — a launch failure must be classified as
 *     non-available here, before `codex login status` on the same bad binary
 *     would be miscategorised as `unauthenticated`/`available: true`.
 *   - bundle NOT found (the SDK throws "Unable to locate Codex CLI binaries",
 *     which is exactly what triggers the handler's fallback) → a validated
 *     system `codex` on PATH (`runtimeSource: "path"`), else binary-missing.
 *
 * Returns the binary path (for the login-status precheck + doctor smoke) plus
 * the `runtimeSource`/`runtimePath` provenance reported to the UI.
 */
export async function resolveCodexRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: CodexRuntimeResolveDeps = {},
): Promise<CodexBinaryResolution> {
  const resolveBundled = deps.resolveBundled ?? resolveBundledCodexBinary;
  const verifyBundled = deps.verifyBundled ?? ((binary: string) => verifyLaunchable("codex", binary));
  const findOnPath = deps.findOnPath ?? findCodexExecutableOnPath;
  const verifyPath = deps.verifyPath ?? verifyCodexExecutable;

  const bundled = await resolveBundled();
  if (bundled.ok) {
    const verified = await verifyBundled(bundled.binary);
    if (!verified.ok) {
      // Present but nonlaunchable — see contract above. Report non-available
      // here (→ `missing`); do not fall back to PATH, do not defer to the auth
      // precheck.
      return {
        ok: false,
        error: `the SDK-bundled codex binary at ${bundled.binary} could not be launched (${verified.error})`,
      };
    }
    return {
      ok: true,
      binary: bundled.binary,
      runtimeSource: "bundled",
      runtimePath: null,
      version: verified.version,
    };
  }

  const pathBinary = findOnPath(env);
  if (pathBinary) {
    const verification = verifyPath(pathBinary, env);
    if (verification.ok) {
      const match = (verification.output ?? "").match(/\d+\.\d+(?:\.\d+)?/);
      return {
        ok: true,
        binary: pathBinary,
        runtimeSource: "path",
        runtimePath: pathBinary,
        version: match ? match[0] : null,
      };
    }
    return {
      ok: false,
      error: formatCodexBinaryMissingMessage(`PATH codex failed validation: ${verification.reason}`),
    };
  }

  return { ok: false, error: formatCodexBinaryMissingMessage(bundled.error) };
}

/** Minimal slice of the `codex doctor --json` report the classifier reads. */
type DoctorCheck = {
  status: string;
  summary: string;
  remediation: string | null;
  details: Record<string, string>;
};

type DoctorReport = {
  codexVersion: string | null;
  checks: Record<string, DoctorCheck>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // The typeof/null/Array checks above guarantee a plain object shape; this
  // is the canonical `unknown` → record narrowing (no runtime risk).
  return value as Record<string, unknown>;
}

/**
 * Parse the doctor JSON (schemaVersion 1) into the minimal report shape.
 * Returns null when the payload is not the expected structure — the caller
 * then degrades rather than misclassifying.
 */
export function parseDoctorReport(raw: string): DoctorReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const checksRaw = asRecord(root.checks);
  if (!checksRaw) return null;
  const checks: Record<string, DoctorCheck> = {};
  for (const [id, value] of Object.entries(checksRaw)) {
    const check = asRecord(value);
    if (!check) continue;
    if (typeof check.status !== "string" || typeof check.summary !== "string") continue;
    const detailsRaw = asRecord(check.details);
    const details: Record<string, string> = {};
    if (detailsRaw) {
      for (const [k, v] of Object.entries(detailsRaw)) {
        if (typeof v === "string") details[k] = v;
      }
    }
    checks[id] = {
      status: check.status,
      summary: check.summary,
      remediation: typeof check.remediation === "string" ? check.remediation : null,
      details,
    };
  }
  return {
    codexVersion: typeof root.codexVersion === "string" ? root.codexVersion : null,
    checks,
  };
}

const AUTH_ERROR_PATTERN = /401|unauthorized|403|forbidden|invalid api key|incorrect api key|credentials/i;

/**
 * Classify a parsed doctor report into a probe state. Field semantics were
 * verified against a real codex binary in all three states:
 *   - logged in:    auth.credentials ok, websocket check ok
 *                    ("Responses WebSocket handshake succeeded")
 *   - no creds:     auth.credentials fail ("no Codex credentials were found")
 *   - invalid key:  auth.credentials ok (file exists) but the websocket check
 *                    warns with `details["handshake transport error"]` carrying
 *                    the provider's verbatim "http 401 Unauthorized: …"
 *
 * `overallStatus` is deliberately ignored — it aggregates unrelated warnings
 * (update checks, MCP config) that must not fail the capability probe.
 */
export function classifyDoctorReport(report: DoctorReport): SmokeOutcome {
  const version = report.codexVersion;

  const auth = report.checks["auth.credentials"];
  if (auth && auth.status === "fail") {
    const detail = auth.remediation ? `${auth.summary} (${auth.remediation})` : auth.summary;
    return { state: "unauthenticated", error: detail, version };
  }

  const ws = report.checks["network.websocket_reachability"];
  if (!ws) {
    // Schema drift guard: a future doctor without this check still proved a
    // real launch + credential read, so degrade instead of failing.
    return { state: "ok", degraded: true, version };
  }
  if (ws.status === "ok") return { state: "ok", version };

  const transportError = ws.details["handshake transport error"];
  const detail = transportError ? `${ws.summary}: ${transportError}` : ws.summary;
  if (AUTH_ERROR_PATTERN.test(detail)) {
    return { state: "unauthenticated", error: detail, version };
  }
  return { state: "error", error: detail, version };
}

/**
 * Smoke via `codex doctor --json` — a zero-token REAL verification: doctor
 * loads the actual credentials and performs an authenticated WebSocket
 * `probe_handshake` against the live Responses endpoint (codex-rs
 * cli/src/doctor.rs), so `ok` here means "this machine can reach the model
 * provider with working credentials", at ~3.4s and no token spend.
 *
 * Older codex builds without the `doctor` subcommand degrade to the weaker
 * "launchable + logged in" claim already established by the resolve and
 * precheck stages (`degraded: true` flags the weaker meaning).
 */
async function defaultCodexDoctorSmoke(binary: string): Promise<SmokeOutcome> {
  const res = await runCommand(binary, ["doctor", "--json"], { timeoutMs: CODEX_DOCTOR_TIMEOUT_MS });
  if (res.spawnError || res.timedOut) {
    return { state: "error", error: commandFailureDigest("`codex doctor`", res) };
  }
  const report = parseDoctorReport(res.stdout);
  if (report) return classifyDoctorReport(report);
  if (/unrecognized subcommand|unexpected argument|usage: codex/i.test(res.stderr + res.stdout)) {
    // Version guard: this codex predates `doctor`.
    return { state: "ok", degraded: true };
  }
  if (!res.ok) return { state: "error", error: commandFailureDigest("`codex doctor`", res) };
  return { state: "error", error: "`codex doctor --json` produced unparseable output" };
}

type CodexHandlerEngine = "app-server" | "sdk" | "auto";

type CodexAppServerSmoke = (binary: string, env: NodeJS.ProcessEnv) => Promise<void>;

type CodexDoctorSmoke = (binary: string) => Promise<SmokeOutcome>;

function codexHandlerEngineFromEnv(env: NodeJS.ProcessEnv): CodexHandlerEngine {
  const raw = env.FIRST_TREE_CODEX_HANDLER_ENGINE?.trim().toLowerCase();
  if (raw === "app-server" || raw === "sdk" || raw === "auto") return raw;
  if (env.NODE_ENV === "test" || env.VITEST) return "sdk";
  return "auto";
}

async function tryCodexAppServerSmoke(
  binary: string,
  env: NodeJS.ProcessEnv,
  appServerSmoke: CodexAppServerSmoke,
): Promise<string | null> {
  try {
    await appServerSmoke(binary, env);
    return null;
  } catch (err) {
    return `codex app-server initialize failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function defaultCodexEngineSmoke(
  binary: string,
  env: NodeJS.ProcessEnv,
  appServerSmoke: CodexAppServerSmoke = smokeCodexAppServer,
  doctorSmoke: CodexDoctorSmoke = defaultCodexDoctorSmoke,
): Promise<SmokeOutcome> {
  const engine = codexHandlerEngineFromEnv(env);
  if (engine === "sdk") return doctorSmoke(binary);

  const appServerError = await tryCodexAppServerSmoke(binary, env, appServerSmoke);
  if (!appServerError) return doctorSmoke(binary);
  if (engine === "app-server") return { state: "error", error: appServerError };

  const sdkOutcome = await doctorSmoke(binary);
  const fallbackError =
    sdkOutcome.error && sdkOutcome.error.length > 0
      ? `${appServerError}; SDK fallback also failed: ${sdkOutcome.error}`
      : `${appServerError}; using @openai/codex-sdk fallback without active-turn steer`;
  if (sdkOutcome.state === "ok") {
    return { ...sdkOutcome, degraded: true, error: fallbackError };
  }
  return { ...sdkOutcome, error: fallbackError };
}

async function defaultLoginStatus(binary: string): Promise<AuthPrecheckOutcome> {
  // Real, free, fast (~0.1s): exit 0 when logged in, exit 1 + "Not logged in"
  // otherwise. This replaces the legacy `existsSync(auth.json)` heuristic that
  // accepted empty/expired credential files.
  const res = await runCommand(binary, ["login", "status"], { timeoutMs: 10_000 });
  if (res.ok) return { ok: true, method: "auth_json" };
  return { ok: false, error: commandFailureDigest("`codex login status`", res) };
}

/** Injectable seams — production callers pass nothing. */
export type CodexProbeDeps = {
  resolveRuntimeBinary?: (env?: NodeJS.ProcessEnv) => Promise<CodexBinaryResolution>;
  loginStatus?: (binary: string) => Promise<AuthPrecheckOutcome>;
  appServerSmoke?: CodexAppServerSmoke;
  doctorSmoke?: CodexDoctorSmoke;
  runSmoke?: (binary: string) => Promise<SmokeOutcome>;
  env?: NodeJS.ProcessEnv;
};

/**
 * Launch-verified probe for the `codex` runtime.
 *
 * Stage map:
 *   1. resolve — locate the binary the runtime spawns, in the handler's order
 *      (SDK-bundled vendor binary first, then a validated system `codex` on
 *      PATH) and launch-verify it. Reports `runtimeSource` / `runtimePath`.
 *   2. auth precheck — `codex login status` (free). CODEX_API_KEY short-cuts
 *      it: an explicit key overrides whatever login state auth.json carries.
 *   3. smoke — aligned with FIRST_TREE_CODEX_HANDLER_ENGINE: sdk only runs
 *      `codex doctor --json`; app-server requires app-server initialize before
 *      doctor; auto reports SDK fallback as available but degraded if app-server
 *      initialize fails.
 */
export async function probeCodexCapability(deps: CodexProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const resolveRuntimeBinary = deps.resolveRuntimeBinary ?? resolveCodexRuntimeBinary;
  const loginStatus = deps.loginStatus ?? defaultLoginStatus;
  const runSmoke =
    deps.runSmoke ?? ((binary: string) => defaultCodexEngineSmoke(binary, env, deps.appServerSmoke, deps.doctorSmoke));

  let resolvedBinary: string | undefined;

  return runLaunchProbe({
    resolve: async (): Promise<ResolveOutcome> => {
      const resolution = await resolveRuntimeBinary(env);
      if (!resolution.ok) return { ok: false, error: resolution.error };
      resolvedBinary = resolution.binary;
      return {
        ok: true,
        binary: resolution.binary,
        version: resolution.version,
        meta: { runtimeSource: resolution.runtimeSource, runtimePath: resolution.runtimePath },
      };
    },
    authPrecheck: async (): Promise<AuthPrecheckOutcome> => {
      if (env.CODEX_API_KEY && env.CODEX_API_KEY.length > 0) {
        return { ok: true, method: "api_key" };
      }
      if (!resolvedBinary) return { ok: false, error: "no resolved codex binary" };
      return loginStatus(resolvedBinary);
    },
    smoke: async (): Promise<SmokeOutcome> => {
      if (!resolvedBinary) return { state: "error", error: "no resolved codex binary for smoke" };
      return runSmoke(resolvedBinary);
    },
  });
}
