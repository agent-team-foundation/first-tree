import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertPathInsideWorkspace,
  buildLandingCodexAppServerArgs,
  buildLandingCodexPermissionsConfigOverride,
  buildWorkspaceOnlyAppServerEnvironment,
  buildWorkspaceOnlyBubblewrapArgs,
  buildWorkspaceOnlyEnvironment,
  LANDING_CODEX_HOST_CREDENTIAL_DENY_RELATIVE_PATHS,
  LANDING_CODEX_PERMISSIONS_PROFILE,
  prepareWorkspaceOnlyOutboxHome,
} from "../handlers/codex/app-server/workspace-sandbox.js";
import { setCliBinding } from "../runtime/cli-binding.js";

let root: string;
let workspace: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ft-workspace-sandbox-")));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  setCliBinding({ binName: "first-tree-test", packageName: null });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("workspace-only sandbox", () => {
  it("allows paths inside the workspace", () => {
    const nested = join(workspace, "nested");
    mkdirSync(nested);

    expect(assertPathInsideWorkspace("nested", workspace, "cwd")).toBe(nested);
    expect(assertPathInsideWorkspace(nested, workspace, "cwd")).toBe(nested);
  });

  it("rejects relative, absolute, and symlink escapes", () => {
    const outsideChild = join(outside, "child");
    mkdirSync(outsideChild);
    symlinkSync(outsideChild, join(workspace, "escape"));

    expect(() => assertPathInsideWorkspace("../outside", workspace, "cwd")).toThrow(/escapes workspace-only/);
    expect(() => assertPathInsideWorkspace(outsideChild, workspace, "cwd")).toThrow(/escapes workspace-only/);
    expect(() => assertPathInsideWorkspace("escape", workspace, "cwd")).toThrow(/escapes workspace-only/);
  });

  it("builds a bubblewrap command that binds the workspace read-write and hides ordinary host data paths", () => {
    const command = join(workspace, "fake-codex");
    writeFileSync(command, "#!/bin/sh\n");
    const cliBinDir = join(root, "first-tree-home", "bin");
    mkdirSync(cliBinDir, { recursive: true });
    writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });
    const sandboxEnv = buildWorkspaceOnlyEnvironment(
      {
        FIRST_TREE_HOME: join(root, "first-tree-home"),
        FIRST_TREE_CLI_BIN_DIR: cliBinDir,
        FIRST_TREE_SERVER_URL: "https://first-tree.test",
        OPENAI_API_KEY: "secret",
        GITHUB_TOKEN: "secret",
        PATH: process.env.PATH ?? "",
      },
      workspace,
    );

    const args = buildWorkspaceOnlyBubblewrapArgs({
      command,
      args: ["app-server", "--stdio"],
      workspaceRoot: workspace,
      cwd: workspace,
      env: sandboxEnv.env,
      readOnlyPaths: sandboxEnv.readOnlyPaths,
    });

    expect(args).toContain("--unshare-all");
    expect(args).toContain("--clearenv");
    expect(args).toContain("--share-net");
    expect(args).toEqual(expect.arrayContaining(["--bind", workspace, workspace]));
    expect(args).toEqual(expect.arrayContaining(["--ro-bind", cliBinDir, cliBinDir]));
    expect(args).toEqual(expect.arrayContaining(["--chdir", workspace]));
    expect(args).toEqual(expect.arrayContaining(["--setenv", "HOME", workspace]));
    expect(args).toEqual(expect.arrayContaining(["--setenv", "FIRST_TREE_SERVER_URL", "https://first-tree.test"]));
    expect(args).not.toContain("OPENAI_API_KEY");
    expect(args).not.toContain("GITHUB_TOKEN");
    expect(args.slice(-3)).toEqual([command, "app-server", "--stdio"]);
    expect(args).not.toContain(process.env.HOME ?? "/home");
    expect(args).not.toContain(outside);
  });

  it("uses the controlled standard tool PATH when no explicit CLI bin dir is configured", () => {
    setCliBinding({ binName: "sh", packageName: null });
    const firstTreeHome = join(root, "first-tree-home");
    const { env, readOnlyPaths } = buildWorkspaceOnlyEnvironment(
      {
        FIRST_TREE_HOME: firstTreeHome,
        PATH: "/sensitive/bin:/usr/bin",
      },
      workspace,
    );

    const pathDirs = env.PATH?.split(delimiter) ?? [];
    expect(pathDirs).toContain(env.FIRST_TREE_CLI_BIN_DIR);
    expect(pathDirs).toContain("/usr/bin");
    expect(pathDirs).toContain("/bin");
    expect(env.PATH).not.toContain("/sensitive/bin");
    expect(readOnlyPaths).toEqual([]);
  });

  it("fails closed when the channel CLI is absent from the controlled standard tool PATH", () => {
    const firstTreeHome = join(root, "first-tree-home");

    expect(() => buildWorkspaceOnlyEnvironment({ FIRST_TREE_HOME: firstTreeHome }, workspace)).toThrow(
      /could not find channel-local First Tree CLI first-tree-test in controlled PATH directories/,
    );
  });

  it("scrubs parent env and uses an explicit non-standard CLI bin dir", () => {
    const firstTreeHome = join(root, "first-tree-home");
    const cliBinDir = join(root, "explicit-cli-bin");
    mkdirSync(cliBinDir, { recursive: true });

    writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });
    const { env, readOnlyPaths } = buildWorkspaceOnlyEnvironment(
      {
        FIRST_TREE_HOME: firstTreeHome,
        FIRST_TREE_CLI_BIN_DIR: cliBinDir,
        FIRST_TREE_SERVER_URL: "https://first-tree.test",
        FIRST_TREE_AGENT_ID: "agent-1",
        FIRST_TREE_CHAT_ID: "chat-1",
        OPENAI_API_KEY: "secret",
        GH_TOKEN: "secret",
        FIRST_TREE_DOC_BASE: outside,
        FIRST_TREE_WORKSPACES_ROOT: root,
        PATH: "/sensitive/bin:/usr/bin",
      },
      workspace,
    );

    expect(env).toMatchObject({
      FIRST_TREE_HOME: firstTreeHome,
      FIRST_TREE_SERVER_URL: "https://first-tree.test",
      FIRST_TREE_AGENT_ID: "agent-1",
      FIRST_TREE_CHAT_ID: "chat-1",
      HOME: workspace,
      TMPDIR: "/tmp",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.FIRST_TREE_DOC_BASE).toBeUndefined();
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBeUndefined();
    expect(env.PATH?.split(delimiter)[0]).toBe(cliBinDir);
    expect(env.PATH).not.toContain("/sensitive/bin");
    expect(readOnlyPaths).toEqual([cliBinDir]);
  });

  it("builds a landing app-server env that keeps Codex auth location without leaking host secrets", () => {
    const hostHome = join(root, "host-home");
    const codexHome = join(hostHome, ".codex");
    const ghConfigDir = join(hostHome, ".config", "gh");
    const sshKeyPath = join(hostHome, ".ssh", "id_ed25519");
    const firstTreeHome = join(workspace, ".first-tree-workspace", "outbox-home");
    const cliBinDir = join(root, "explicit-cli-bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(ghConfigDir, { recursive: true });
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    mkdirSync(firstTreeHome, { recursive: true });
    mkdirSync(cliBinDir, { recursive: true });
    writeFileSync(sshKeyPath, "ssh-secret\n", { mode: 0o600 });
    writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });

    const {
      env,
      codexHome: resolvedCodexHome,
      hostHome: resolvedHostHome,
    } = buildWorkspaceOnlyAppServerEnvironment(
      {
        HOME: hostHome,
        FIRST_TREE_HOME: firstTreeHome,
        FIRST_TREE_CLI_BIN_DIR: cliBinDir,
        FIRST_TREE_SERVER_URL: "https://first-tree.test",
        FIRST_TREE_AGENT_ID: "agent-1",
        FIRST_TREE_RUNTIME_SESSION_TOKEN: "runtime-secret",
        FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/host/runtime-token",
        FIRST_TREE_DOC_BASE: outside,
        FIRST_TREE_WORKSPACES_ROOT: root,
        OPENAI_API_KEY: "openai-secret",
        CODEX_API_KEY: "codex-secret",
        GITHUB_TOKEN: "github-secret",
        HTTP_PROXY: "http://user:password@proxy.test:8080",
        HTTPS_PROXY: "http://user:password@proxy.test:8080",
        GIT_SSH_COMMAND: "ssh -i /host/secret",
        SSL_CERT_FILE: join(outside, "ca.pem"),
        NODE_EXTRA_CA_CERTS: join(outside, "node-ca.pem"),
        PATH: "/sensitive/bin:/usr/bin",
      },
      workspace,
    );

    expect(resolvedCodexHome).toBe(codexHome);
    expect(resolvedHostHome).toBe(hostHome);
    expect(env).toMatchObject({
      FIRST_TREE_HOME: firstTreeHome,
      FIRST_TREE_SERVER_URL: "https://first-tree.test",
      FIRST_TREE_AGENT_ID: "agent-1",
      HOME: workspace,
      CODEX_HOME: codexHome,
      GH_CONFIG_DIR: ghConfigDir,
      TMPDIR: "/tmp",
    });
    expect(env.GIT_SSH_COMMAND).toContain("-F /dev/null");
    expect(env.GIT_SSH_COMMAND).toContain(sshKeyPath);
    expect(env.GIT_SSH_COMMAND).toContain(join(firstTreeHome, "ssh", "known_hosts"));
    expect(env.GIT_SSH_COMMAND).toContain("IdentitiesOnly=yes");
    expect(env.GIT_SSH_COMMAND).toContain("StrictHostKeyChecking=accept-new");
    expect(env.GIT_SSH_COMMAND).not.toContain("/host/secret");
    expect(env.PATH?.split(delimiter)[0]).toBe(cliBinDir);
    expect(env.PATH).not.toContain("/sensitive/bin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.SSL_CERT_FILE).toBeUndefined();
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN).toBeUndefined();
    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE).toBeUndefined();
    expect(env.FIRST_TREE_DOC_BASE).toBeUndefined();
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBeUndefined();
  });

  it("builds landing Codex app-server args with a default permissions profile", () => {
    const hostHome = join(root, "host-home");
    const codexHome = join(hostHome, ".codex");
    mkdirSync(codexHome, { recursive: true });

    expect(buildLandingCodexAppServerArgs(workspace, codexHome, hostHome)).toEqual([
      "-c",
      buildLandingCodexPermissionsConfigOverride(workspace, codexHome, hostHome),
      "-c",
      `default_permissions=${JSON.stringify(LANDING_CODEX_PERMISSIONS_PROFILE)}`,
    ]);
  });

  it("allows host system reads while denying selected host credentials in the landing Codex profile", () => {
    const hostHome = join(root, "host-home");
    const codexHome = join(hostHome, ".codex");
    mkdirSync(codexHome, { recursive: true });

    const override = buildLandingCodexPermissionsConfigOverride(workspace, codexHome, hostHome);

    expect(override).toContain(`${JSON.stringify(":root")} = "read"`);
    expect(override).toContain(`${JSON.stringify(workspace)} = "write"`);
    for (const relativePath of LANDING_CODEX_HOST_CREDENTIAL_DENY_RELATIVE_PATHS) {
      expect(override).toContain(`${JSON.stringify(join(hostHome, relativePath))} = "deny"`);
    }
    expect(override).toContain(`${JSON.stringify(codexHome)} = "deny"`);
    expect(override).not.toContain(`${JSON.stringify(join(hostHome, ".ssh"))} = "deny"`);
    expect(override).not.toContain(".config/gh");
    expect(override).not.toContain(".git-credentials");
  });

  it("does not add an extra read-only bind for an explicit CLI dir covered by system mounts", () => {
    setCliBinding({ binName: "sh", packageName: null });

    const { env, readOnlyPaths } = buildWorkspaceOnlyEnvironment(
      {
        FIRST_TREE_HOME: join(root, "first-tree-home"),
        FIRST_TREE_CLI_BIN_DIR: "/bin",
      },
      workspace,
    );

    expect(env.FIRST_TREE_CLI_BIN_DIR).toBe("/bin");
    expect(env.PATH?.split(delimiter)[0]).toBe("/bin");
    expect(readOnlyPaths).toEqual([]);
  });

  it("builds a workspace-local First Tree home with only scoped outbox credentials", () => {
    const hostHome = join(root, "host-first-tree-home");
    const cliBinDir = join(root, "explicit-cli-bin");
    mkdirSync(cliBinDir, { recursive: true });
    writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });

    const prepared = prepareWorkspaceOnlyOutboxHome({
      parentEnv: {
        FIRST_TREE_HOME: hostHome,
        FIRST_TREE_CLI_BIN_DIR: cliBinDir,
        FIRST_TREE_SERVER_URL: "https://first-tree.test",
        OPENAI_API_KEY: "secret",
      },
      workspaceRoot: workspace,
      agentId: "agent-trial",
      runtimeProvider: "codex",
      accessToken: "scoped-outbox-token",
      serverUrl: "https://first-tree.test",
    });

    expect(prepared.home).toBe(join(workspace, ".first-tree-workspace", "outbox-home"));
    expect(prepared.cliBinDir).toBe(cliBinDir);
    expect(prepared.env.FIRST_TREE_HOME).toBe(prepared.home);
    expect(prepared.env.FIRST_TREE_CLI_BIN_DIR).toBe(cliBinDir);
    expect(existsSync(join(prepared.home, "config", "agents", "landing-campaign-trial", "agent.yaml"))).toBe(true);
    expect(
      readFileSync(join(prepared.home, "config", "agents", "landing-campaign-trial", "agent.yaml"), "utf8"),
    ).toContain('agentId: "agent-trial"');
    expect(JSON.parse(readFileSync(join(prepared.home, "config", "credentials.json"), "utf8"))).toMatchObject({
      accessToken: "scoped-outbox-token",
      refreshToken: "scoped-outbox-token",
      serverUrl: "https://first-tree.test",
    });
  });
});
