/**
 * macOS launchd integration for background daemon lifecycle.
 *
 * Port of the `start_with_launchctl`, `stop_launchd_job`,
 * `launchd_plist_contents`, `launchd_label`, `launchd_domain`,
 * `passthrough_launchd_env_vars`, `resolve_launchd_env_var`, and
 * `escape_xml` helpers from
 * `service.rs`.
 *
 * Linux / Windows are intentional no-ops — callers should fall back to
 * a `nohup` spawn via `spawn(...)` with `detached: true` when
 * `supportsLaunchd() === false`.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { sanitizeFilename } from "./workspace.js";

export interface LaunchdPlistInputs {
  /** Human-readable login (for label disambiguation). */
  login: string;
  /** Profile name (`default` in single-tenant). */
  profile: string;
  /** Absolute path to the CLI entrypoint to launch. */
  executable: string;
  /** Arguments after the executable (not including the bin itself). */
  arguments: readonly string[];
  /** File to receive stdout + stderr. */
  logPath: string;
  /** Extra env variables (HOME / PATH are added automatically). */
  env?: Record<string, string | undefined>;
  /**
   * How to fetch a passthrough env var that isn't already in `env`.
   * Defaults to `resolveLaunchdEnvVar`, which shells out to
   * `/bin/zsh -lc` — fine in production, but kills test perf on slow
   * login shells. Pass a no-op or a stub in tests.
   */
  resolveEnvVar?: (variable: string) => string | undefined;
  /**
   * How to enumerate env vars from the user's login shell. Defaults to
   * `readLoginShellEnvVarNames`, which shells out once. Tests pass an
   * explicit list (or `[]`) to avoid the subshell.
   */
  loginShellVars?: readonly string[];
}

/** True on darwin with `launchctl` available. */
export function supportsLaunchd(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execSync("command -v launchctl", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** `com.first-tree.auto.<login>.<profile>` — matches Rust `launchd_label`. */
export function launchdLabel(login: string, profile: string): string {
  return `com.first-tree.auto.${sanitizeFilename(login)}.${sanitizeFilename(profile)}`;
}

/**
 * `<runnerHome>/launchd/<label>.plist`. Mirrors Rust `launchd_plist_path`.
 */
export function launchdPlistPath(runnerHome: string, label: string): string {
  return join(runnerHome, "launchd", `${label}.plist`);
}

/**
 * Resolve the user domain `gui/<uid>` via `id -u`. Used by
 * `launchctl bootstrap`/`bootout`.
 */
export function launchdDomain(): string {
  const result = spawnSync("id", ["-u"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `resolve user id for launchd failed: ${result.stderr?.trim() ?? ""}`,
    );
  }
  const uid = (result.stdout ?? "").split("\n")[0]?.trim();
  if (!uid) throw new Error("could not resolve numeric user id for launchd");
  return `gui/${uid}`;
}

/**
 * Env vars we pass through to the launchd job. Matches Rust
 * `passthrough_launchd_env_vars`. Caller-supplied `env` overrides.
 */
export const PASSTHROUGH_ENV_VARS: readonly string[] = [
  "AUTO_DIR",
  "AUTO_HOME",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT_BACKUP",
  "AZURE_OPENAI_API_KEY_BACKUP",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "CODEX_HOME",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

/**
 * Agent CLIs may authenticate via a wider provider-specific env surface than
 * the small Rust-era static allowlist above (for example Azure test slots,
 * OpenAI-compatible base URLs, Bedrock/Vertex creds). Discover those families
 * dynamically so background launchd jobs inherit the same auth context as the
 * interactive shell that started Breeze.
 */
export const PASSTHROUGH_ENV_PREFIXES: readonly string[] = [
  "AZURE_OPENAI_",
  "OPENAI_",
  "ANTHROPIC_",
  "AWS_",
  "GOOGLE_",
];

/**
 * Resolve one env var value, falling back to `/bin/zsh -lc` so we pick
 * up variables the GUI session sets in the user's login shell. Mirrors
 * Rust `resolve_launchd_env_var` + `resolve_env_var_from_login_shell`.
 */
export function resolveLaunchdEnvVar(
  variable: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const direct = env[variable];
  if (direct && direct.trim().length > 0) return direct;
  try {
    const result = spawnSync(
      "/bin/zsh",
      ["-lc", `printf '%s' "\${${variable}:-}"`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status !== 0) return undefined;
    const value = result.stdout ?? "";
    if (value.trim().length === 0) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function matchesPassthroughPrefix(variable: string): boolean {
  return PASSTHROUGH_ENV_PREFIXES.some((prefix) => variable.startsWith(prefix));
}

function parseEnvVarNames(raw: string): string[] {
  const names: string[] = [];
  for (const line of raw.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function readLoginShellEnvVarNames(): string[] {
  try {
    const result = spawnSync("/bin/zsh", ["-lc", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) return [];
    return parseEnvVarNames(result.stdout ?? "");
  } catch {
    return [];
  }
}

export function collectLaunchdPassthroughEnvVars(
  env: NodeJS.ProcessEnv = process.env,
  loginShellVars: readonly string[] = readLoginShellEnvVarNames(),
): string[] {
  const ordered = [...PASSTHROUGH_ENV_VARS];
  const seen = new Set<string>(ordered);
  const candidates = [
    ...Object.keys(env),
    ...loginShellVars,
  ].filter(matchesPassthroughPrefix);
  for (const variable of candidates.sort()) {
    if (seen.has(variable)) continue;
    ordered.push(variable);
    seen.add(variable);
  }
  return ordered;
}

/** Port of the `escape_xml` helper. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the plist XML for a breeze-runner launchd job. Byte-shape match
 * with Rust `launchd_plist_contents`.
 */
export function renderLaunchdPlist(inputs: LaunchdPlistInputs): string {
  const label = launchdLabel(inputs.login, inputs.profile);
  const programArgs = [inputs.executable, ...inputs.arguments];
  const argumentsXml = programArgs
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const envPairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  const pushEnv = (key: string, value: string | undefined): void => {
    if (!value || value.trim().length === 0) return;
    if (seen.has(key)) return;
    envPairs.push([key, value]);
    seen.add(key);
  };
  pushEnv("PATH", inputs.env?.PATH ?? process.env.PATH);
  pushEnv("HOME", inputs.env?.HOME ?? process.env.HOME);
  for (const [key, value] of Object.entries(inputs.env ?? {})) {
    pushEnv(key, value);
  }
  const resolveVar = inputs.resolveEnvVar ?? resolveLaunchdEnvVar;
  const passthroughVars = collectLaunchdPassthroughEnvVars(
    { ...process.env, ...inputs.env },
    inputs.loginShellVars ?? readLoginShellEnvVarNames(),
  );
  for (const variable of passthroughVars) {
    // Only fall back to the resolver for vars not already supplied;
    // keeps tests and deterministic callers subprocess-free.
    const supplied = inputs.env?.[variable];
    pushEnv(variable, supplied ?? resolveVar(variable));
  }

  const environmentXml = envPairs
    .map(
      ([key, value]) =>
        `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(inputs.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(inputs.logPath)}</string>
</dict>
</plist>
`;
}

export interface BootstrapLaunchdJobOptions {
  runnerHome: string;
  login: string;
  profile: string;
  executable: string;
  arguments: readonly string[];
  logPath: string;
  env?: Record<string, string | undefined>;
}

export interface BootstrapLaunchdJobResult {
  label: string;
  domain: string;
  plistPath: string;
}

/**
 * Write the plist, `bootout` any previous instance, then `bootstrap` +
 * `kickstart -k`. Mirrors `start_with_launchctl`.
 */
export function bootstrapLaunchdJob(
  options: BootstrapLaunchdJobOptions,
): BootstrapLaunchdJobResult {
  const label = launchdLabel(options.login, options.profile);
  const plistPath = launchdPlistPath(options.runnerHome, label);
  mkdirSync(dirname(plistPath), { recursive: true });
  writeFileSync(
    plistPath,
    renderLaunchdPlist({
      login: options.login,
      profile: options.profile,
      executable: options.executable,
      arguments: options.arguments,
      logPath: options.logPath,
      env: options.env,
    }),
  );

  const domain = launchdDomain();
  // Ignore bootout failure — the job may not be running yet.
  spawnSync("launchctl", ["bootout", domain, plistPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const bootstrap = spawnSync(
    "launchctl",
    ["bootstrap", domain, plistPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (bootstrap.status !== 0) {
    throw new Error(
      `launchctl bootstrap failed (exit ${bootstrap.status}): ${bootstrap.stderr?.trim() ?? ""}`,
    );
  }

  const target = `${domain}/${label}`;
  const kickstart = spawnSync(
    "launchctl",
    ["kickstart", "-k", target],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // 113 means the job is already running; launchctl returns that when
  // kickstart is racing with RunAtLoad. Treat as success.
  if (kickstart.status !== 0 && kickstart.status !== 113) {
    throw new Error(
      `launchctl kickstart failed (exit ${kickstart.status}): ${kickstart.stderr?.trim() ?? ""}`,
    );
  }

  return { label, domain, plistPath };
}

/**
 * `launchctl bootout` if a plist exists for this job. Never throws.
 */
export function stopLaunchdJob(runnerHome: string, login: string, profile: string): void {
  const label = launchdLabel(login, profile);
  const plistPath = launchdPlistPath(runnerHome, label);
  if (!existsSync(plistPath)) return;
  let domain: string;
  try {
    domain = launchdDomain();
  } catch {
    return;
  }
  spawnSync("launchctl", ["bootout", domain, plistPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}
