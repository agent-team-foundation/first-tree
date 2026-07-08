import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getCliBinding } from "../../../runtime/cli-binding.js";
import type { SpawnProcess } from "./client.js";

type BuildBubblewrapArgsOptions = {
  command: string;
  args: readonly string[];
  workspaceRoot: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readOnlyPaths?: readonly string[];
};

type WorkspaceOnlySpawnOptions = {
  workspaceRoot: string;
  sandboxBinary?: string;
  readOnlyPaths?: readonly string[];
};

type WorkspaceOnlyEnvironment = {
  env: NodeJS.ProcessEnv;
  readOnlyPaths: string[];
};

type WorkspaceOnlyAppServerEnvironment = {
  env: NodeJS.ProcessEnv;
  codexHome: string;
  hostHome: string;
};

type LandingCodexPermissionProfileConfig = {
  description: string;
  workspace_roots: Record<string, true>;
  filesystem: Record<string, "read" | "write" | "deny">;
  network: {
    enabled: true;
  };
};

type TomlInlinePrimitive = string | number | boolean;
type TomlInlineValue = TomlInlinePrimitive | TomlInlineObject;
type TomlInlineObject = {
  [key: string]: TomlInlineValue;
};

type WorkspaceOnlyCliResolution = {
  cliBinDir: string;
  pathDirs: string[];
  readOnlyPaths: string[];
};

type WorkspaceOnlyOutboxHomeOptions = {
  parentEnv: NodeJS.ProcessEnv;
  workspaceRoot: string;
  agentId: string;
  runtimeProvider: string;
  accessToken: string;
  serverUrl: string;
};

const DEFAULT_SANDBOX_BINARY = "bwrap";
const READ_ONLY_SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64"] as const;
const READ_ONLY_ETC_PATHS = [
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/nsswitch.conf",
  "/etc/protocols",
  "/etc/services",
] as const;
const LANDING_CODEX_ROOT_READ_PATH = ":root";
export const LANDING_CODEX_HOST_CREDENTIAL_DENY_RELATIVE_PATHS = [
  ".codex",
  ".first-tree",
  ".first-tree-staging",
  ".first-tree-dev",
  ".first-tree-local",
  ".first-tree-test",
] as const;
// Landing trial hosts intentionally leave `.ssh` readable so public-repo
// workflows can use the host trial key. These official hosts must keep
// `~/.ssh` limited to the low-permission GitHub trial keypair only; personal,
// employee, admin, private-repo, or organization-privileged SSH credentials do
// not belong there. Git operations still go through the controlled
// GIT_SSH_COMMAND below (`-F /dev/null`, this key, and workspace-local
// known_hosts).
const LANDING_CODEX_GIT_SSH_KEY_RELATIVE_PATH = join(".ssh", "id_ed25519");
const WORKSPACE_ONLY_PATH_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"] as const;
const SAFE_PASS_ENV_KEYS = new Set([
  "FIRST_TREE_HOME",
  "FIRST_TREE_SERVER_URL",
  "FIRST_TREE_AGENT_ID",
  "FIRST_TREE_INBOX_ID",
  "FIRST_TREE_CHAT_ID",
  "FIRST_TREE_CLIENT_ID",
  "FIRST_TREE_PROVIDER",
  "FIRST_TREE_SWITCH_DRAIN_VERSION",
  "FIRST_TREE_CLI_BIN_DIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
]);
const WORKSPACE_ONLY_APP_SERVER_PASS_ENV_KEYS = new Set([
  "FIRST_TREE_SERVER_URL",
  "FIRST_TREE_AGENT_ID",
  "FIRST_TREE_INBOX_ID",
  "FIRST_TREE_CHAT_ID",
  "FIRST_TREE_CLIENT_ID",
  "FIRST_TREE_PROVIDER",
  "FIRST_TREE_SWITCH_DRAIN_VERSION",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
]);

export const LANDING_CODEX_PERMISSIONS_PROFILE = "first-tree-landing-trial";

function pathIsWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function realpathExisting(path: string, label: string): string {
  try {
    return realpathSync(path);
  } catch (err) {
    throw new Error(`${label} does not exist: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function assertPathInsideWorkspace(path: string, workspaceRoot: string, label: string): string {
  const realWorkspace = realpathExisting(workspaceRoot, "workspaceRoot");
  const target = isAbsolute(path) ? path : resolve(realWorkspace, path);
  const realTarget = realpathExisting(target, label);
  if (!pathIsWithin(realWorkspace, realTarget)) {
    throw new Error(`${label} escapes workspace-only sandbox: ${path}`);
  }
  return realTarget;
}

function findExecutableOnPath(command: string, env: NodeJS.ProcessEnv | undefined): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  const pathValue = env?.PATH ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = resolve(dir, command);
    if (!existsSync(candidate)) continue;
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // Ignore unreadable PATH entries; another entry may resolve.
    }
  }
  return null;
}

function addExistingReadOnlyBind(args: string[], path: string): void {
  if (!existsSync(path)) return;
  args.push("--ro-bind", path, path);
}

function addReadOnlyBind(args: string[], path: string): void {
  if (!existsSync(path)) return;
  const source = realpathExisting(path, "readOnlyPath");
  addParentDirs(args, path);
  args.push("--ro-bind", source, path);
}

function addParentDirs(args: string[], path: string): void {
  const alreadyPresent = new Set(["/tmp", "/proc", "/dev", "/run", "/etc", ...READ_ONLY_SYSTEM_DIRS]);
  const dirs: string[] = [];
  let current = dirname(path);
  while (current && current !== "/") {
    if (!alreadyPresent.has(current)) dirs.push(current);
    current = dirname(current);
  }
  for (const dir of dirs.reverse()) {
    args.push("--dir", dir);
  }
}

function isCoveredBySystemBind(path: string): boolean {
  return READ_ONLY_SYSTEM_DIRS.some((dir) => existsSync(dir) && pathIsWithin(dir, path));
}

function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function uniqueExistingDirs(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const path of paths) {
    const dir = isAbsolute(path) ? path : resolve(path);
    if (!existingDirectory(dir) || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

function validateChannelCliBin(binDir: string, source: string): void {
  const { binName } = getCliBinding();
  const cliPath = join(binDir, binName);
  try {
    accessSync(cliPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`workspace-only sandbox ${source} must contain channel-local First Tree CLI at ${cliPath}`);
  }
}

function resolveHostHome(parentEnv: NodeJS.ProcessEnv, workspaceRoot: string): string {
  const rawHome = parentEnv.HOME?.trim();
  const hostHome = rawHome && rawHome !== workspaceRoot ? rawHome : homedir();
  return isAbsolute(hostHome) ? hostHome : resolve(hostHome);
}

function resolveHostCodexHome(parentEnv: NodeJS.ProcessEnv, hostHome: string): string {
  const rawCodexHome = parentEnv.CODEX_HOME?.trim();
  if (rawCodexHome) {
    return isAbsolute(rawCodexHome) ? rawCodexHome : resolve(hostHome, rawCodexHome);
  }
  return join(hostHome, ".codex");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function landingCodexGitSshCommand(hostHome: string, firstTreeHome: string): string | null {
  const keyPath = join(hostHome, LANDING_CODEX_GIT_SSH_KEY_RELATIVE_PATH);
  if (!existsSync(keyPath)) return null;

  const sshStateDir = join(firstTreeHome, "ssh");
  mkdirSync(sshStateDir, { recursive: true, mode: 0o700 });
  const knownHostsPath = join(sshStateDir, "known_hosts");

  return [
    "ssh",
    "-F",
    "/dev/null",
    "-i",
    shellQuote(keyPath),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `UserKnownHostsFile=${shellQuote(knownHostsPath)}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
  ].join(" ");
}

function addDenyPath(paths: Set<string>, path: string): void {
  paths.add(path);
  if (existsSync(path)) {
    try {
      paths.add(realpathSync(path));
    } catch {
      // A lexical deny still blocks the configured path.
    }
  }
}

export function landingCodexDenyPaths(codexHome: string, hostHome: string): string[] {
  const paths = new Set([codexHome]);
  addDenyPath(paths, codexHome);
  for (const relativePath of LANDING_CODEX_HOST_CREDENTIAL_DENY_RELATIVE_PATHS) {
    addDenyPath(paths, join(hostHome, relativePath));
  }
  return [...paths];
}

export function buildLandingCodexPermissionProfile(
  workspacePath: string,
  codexHome: string,
  hostHome: string,
): LandingCodexPermissionProfileConfig {
  const filesystem: LandingCodexPermissionProfileConfig["filesystem"] = {
    [LANDING_CODEX_ROOT_READ_PATH]: "read",
    [workspacePath]: "write",
  };
  for (const path of landingCodexDenyPaths(codexHome, hostHome)) {
    filesystem[path] = "deny";
  }

  return {
    description: "First Tree landing trial root-read profile with selected host credential denies",
    workspace_roots: {
      [workspacePath]: true,
    },
    filesystem,
    network: {
      enabled: true,
    },
  };
}

function tomlInline(value: TomlInlineValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `{ ${Object.entries(value)
    .map(([key, child]) => `${JSON.stringify(key)} = ${tomlInline(child)}`)
    .join(", ")} }`;
}

export function buildLandingCodexPermissionsConfigOverride(
  workspacePath: string,
  codexHome: string,
  hostHome: string,
): string {
  return `permissions=${tomlInline({
    [LANDING_CODEX_PERMISSIONS_PROFILE]: buildLandingCodexPermissionProfile(workspacePath, codexHome, hostHome),
  })}`;
}

export function buildLandingCodexAppServerArgs(workspacePath: string, codexHome: string, hostHome: string): string[] {
  return [
    "-c",
    buildLandingCodexPermissionsConfigOverride(workspacePath, codexHome, hostHome),
    "-c",
    `default_permissions=${JSON.stringify(LANDING_CODEX_PERMISSIONS_PROFILE)}`,
  ];
}

function resolveWorkspaceOnlyCli(parentEnv: NodeJS.ProcessEnv): WorkspaceOnlyCliResolution {
  const defaultPathDirs = uniqueExistingDirs(WORKSPACE_ONLY_PATH_DIRS);
  const explicit = parentEnv.FIRST_TREE_CLI_BIN_DIR;
  if (explicit) {
    const binDir = isAbsolute(explicit) ? explicit : resolve(explicit);
    validateChannelCliBin(binDir, "FIRST_TREE_CLI_BIN_DIR");
    return {
      cliBinDir: binDir,
      pathDirs: uniqueExistingDirs([binDir, ...WORKSPACE_ONLY_PATH_DIRS]),
      readOnlyPaths: isCoveredBySystemBind(binDir) ? [] : [binDir],
    };
  }

  for (const binDir of defaultPathDirs) {
    try {
      validateChannelCliBin(binDir, "controlled PATH");
      return { cliBinDir: binDir, pathDirs: defaultPathDirs, readOnlyPaths: [] };
    } catch {
      // Keep searching the controlled tool PATH.
    }
  }

  const { binName } = getCliBinding();
  const searched = defaultPathDirs.length > 0 ? defaultPathDirs.join(", ") : "(no existing standard tool dirs)";
  throw new Error(
    `workspace-only sandbox could not find channel-local First Tree CLI ${binName} in controlled PATH directories: ${searched}. Install ${binName} in /usr/local/bin, /usr/bin, or /bin, or set FIRST_TREE_CLI_BIN_DIR to its directory.`,
  );
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}

export function prepareWorkspaceOnlyOutboxHome(options: WorkspaceOnlyOutboxHomeOptions): {
  env: NodeJS.ProcessEnv;
  home: string;
  cliBinDir: string;
} {
  const realWorkspace = realpathExisting(options.workspaceRoot, "workspaceRoot");
  const { cliBinDir } = resolveWorkspaceOnlyCli(options.parentEnv);

  const home = join(realWorkspace, ".first-tree-workspace", "outbox-home");
  const configDir = join(home, "config");
  const agentDir = join(configDir, "agents", "landing-campaign-trial");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writePrivateFile(
    join(configDir, "credentials.json"),
    JSON.stringify(
      {
        accessToken: options.accessToken,
        // Outbox tokens are deliberately non-refreshable. This placeholder
        // satisfies the existing CLI credentials shape without exposing the
        // service user's refresh token inside the sandbox.
        refreshToken: options.accessToken,
        serverUrl: options.serverUrl,
      },
      null,
      2,
    ),
  );
  writePrivateFile(
    join(agentDir, "agent.yaml"),
    `agentId: "${options.agentId}"\nruntime: ${options.runtimeProvider}\n`,
  );

  return {
    env: {
      ...options.parentEnv,
      FIRST_TREE_HOME: home,
      FIRST_TREE_CLI_BIN_DIR: cliBinDir,
    },
    home,
    cliBinDir,
  };
}

export function buildWorkspaceOnlyEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  workspaceRoot: string,
): WorkspaceOnlyEnvironment {
  const realWorkspace = realpathExisting(workspaceRoot, "workspaceRoot");
  const firstTreeHome = parentEnv.FIRST_TREE_HOME;
  if (!firstTreeHome) {
    throw new Error("workspace-only sandbox requires FIRST_TREE_HOME for sandbox-local First Tree config");
  }
  const resolvedHome = isAbsolute(firstTreeHome) ? firstTreeHome : resolve(firstTreeHome);
  const cli = resolveWorkspaceOnlyCli(parentEnv);

  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_PASS_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  env.FIRST_TREE_HOME = resolvedHome;
  env.HOME = realWorkspace;
  env.TMPDIR = "/tmp";
  env.FIRST_TREE_CLI_BIN_DIR = cli.cliBinDir;
  env.PATH = cli.pathDirs.join(delimiter);

  return { env, readOnlyPaths: cli.readOnlyPaths };
}

export function buildWorkspaceOnlyAppServerEnvironment(
  parentEnv: NodeJS.ProcessEnv,
  workspaceRoot: string,
): WorkspaceOnlyAppServerEnvironment {
  const realWorkspace = realpathExisting(workspaceRoot, "workspaceRoot");
  const firstTreeHome = parentEnv.FIRST_TREE_HOME;
  if (!firstTreeHome) {
    throw new Error("workspace-only app-server requires FIRST_TREE_HOME for sandbox-local First Tree config");
  }
  const resolvedFirstTreeHome = assertPathInsideWorkspace(firstTreeHome, realWorkspace, "FIRST_TREE_HOME");
  const cli = resolveWorkspaceOnlyCli(parentEnv);
  const hostHome = resolveHostHome(parentEnv, realWorkspace);
  const codexHome = resolveHostCodexHome(parentEnv, hostHome);

  const env: NodeJS.ProcessEnv = {};
  for (const key of WORKSPACE_ONLY_APP_SERVER_PASS_ENV_KEYS) {
    const value = parentEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  env.FIRST_TREE_HOME = resolvedFirstTreeHome;
  env.HOME = realWorkspace;
  env.CODEX_HOME = codexHome;
  env.TMPDIR = "/tmp";
  env.FIRST_TREE_CLI_BIN_DIR = cli.cliBinDir;
  env.PATH = cli.pathDirs.join(delimiter);
  const hostGhConfigDir = join(hostHome, ".config", "gh");
  if (existingDirectory(hostGhConfigDir)) {
    env.GH_CONFIG_DIR = hostGhConfigDir;
  }
  const gitSshCommand = landingCodexGitSshCommand(hostHome, resolvedFirstTreeHome);
  if (gitSshCommand) {
    env.GIT_SSH_COMMAND = gitSshCommand;
  }
  return { env, codexHome, hostHome };
}

export function buildWorkspaceOnlyBubblewrapArgs(options: BuildBubblewrapArgsOptions): string[] {
  const workspaceRoot = realpathExisting(options.workspaceRoot, "workspaceRoot");
  const cwd = options.cwd ? assertPathInsideWorkspace(options.cwd, workspaceRoot, "cwd") : workspaceRoot;
  const commandPath = findExecutableOnPath(options.command, options.env);
  if (!commandPath) {
    throw new Error(`workspace-only sandbox could not resolve executable: ${options.command}`);
  }
  const commandRealpath = realpathExisting(commandPath, "command");
  if (!statSync(commandRealpath).isFile()) {
    throw new Error(`workspace-only sandbox executable is not a file: ${commandRealpath}`);
  }

  const args = [
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--unshare-all",
    "--share-net",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/run",
    "--dir",
    "/etc",
  ];

  for (const dir of READ_ONLY_SYSTEM_DIRS) {
    addExistingReadOnlyBind(args, dir);
  }
  for (const path of READ_ONLY_ETC_PATHS) {
    addExistingReadOnlyBind(args, path);
  }
  for (const path of options.readOnlyPaths ?? []) {
    addReadOnlyBind(args, path);
  }

  args.push("--bind", workspaceRoot, workspaceRoot);
  if (!pathIsWithin(workspaceRoot, commandRealpath) && !isCoveredBySystemBind(commandRealpath)) {
    addParentDirs(args, commandRealpath);
    args.push("--ro-bind", commandRealpath, commandRealpath);
  }
  args.push("--chdir", cwd);
  for (const [key, value] of Object.entries({ ...(options.env ?? {}), HOME: workspaceRoot, TMPDIR: "/tmp" })) {
    if (typeof value === "string") args.push("--setenv", key, value);
  }
  return [...args, "--", commandRealpath, ...options.args];
}

export function createWorkspaceOnlySpawnProcess(options: WorkspaceOnlySpawnOptions): SpawnProcess {
  const workspaceRoot = realpathExisting(options.workspaceRoot, "workspaceRoot");
  return (command, args, spawnOptions) => {
    if (process.platform !== "linux") {
      throw new Error("workspace-only sandbox requires Linux bubblewrap support");
    }
    const sandboxBinary = options.sandboxBinary ?? DEFAULT_SANDBOX_BINARY;
    const resolvedSandbox = findExecutableOnPath(sandboxBinary, spawnOptions.env);
    if (!resolvedSandbox) {
      throw new Error("workspace-only sandbox requires bubblewrap (`bwrap`) on PATH");
    }
    const sandboxEnv = buildWorkspaceOnlyEnvironment(spawnOptions.env ?? {}, workspaceRoot);
    const readOnlyPaths = [...new Set([...sandboxEnv.readOnlyPaths, ...(options.readOnlyPaths ?? [])])];
    const sandboxArgs = buildWorkspaceOnlyBubblewrapArgs({
      command,
      args,
      workspaceRoot,
      cwd: spawnOptions.cwd,
      env: sandboxEnv.env,
      readOnlyPaths,
    });
    return spawn(resolvedSandbox, sandboxArgs, {
      ...spawnOptions,
      env: sandboxEnv.env,
      cwd: workspaceRoot,
    });
  };
}
