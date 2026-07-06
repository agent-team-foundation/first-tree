import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexAppServerClient, type CodexAppServerNotification } from "../handlers/codex/app-server/client.js";
import {
  buildLandingCodexAppServerArgs,
  buildLandingCodexPermissionProfile,
  buildWorkspaceOnlyAppServerEnvironment,
  LANDING_CODEX_PERMISSIONS_PROFILE,
} from "../handlers/codex/app-server/workspace-sandbox.js";
import { FIRST_TREE_WORKSPACE_MARKER } from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";

const RUN_SMOKE = process.env.RUN_CODEX_LANDING_APP_SERVER_SMOKE === "1";
const PROVIDER_CHECK_ENABLED = process.env.SKIP_CODEX_LANDING_PROVIDER_SMOKE !== "1";
const describeSmoke = RUN_SMOKE ? describe : describe.skip;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function commandOutput(command: string): string {
  return execFileSync("sh", ["-lc", command], { encoding: "utf8" }).trim();
}

function resolveBinary(envName: string, fallbackCommand: string): string {
  const explicit = process.env[envName]?.trim();
  if (explicit) return explicit;
  return commandOutput(`command -v ${fallbackCommand}`);
}

function resolveCliPath(): string {
  const explicit = process.env.FIRST_TREE_SMOKE_CLI?.trim();
  if (explicit) return explicit;
  return commandOutput("command -v first-tree-staging || command -v first-tree");
}

function hostCodexHome(): string {
  const raw = process.env.CODEX_HOME?.trim();
  if (raw) return isAbsolute(raw) ? raw : resolve(homedir(), raw);
  return join(homedir(), ".codex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readTurnId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct = record.turnId ?? record.turn_id;
  if (typeof direct === "string") return direct;
  const turn = asRecord(record.turn);
  if (!turn) return null;
  const nested = turn.id ?? turn.turnId ?? turn.turn_id;
  return typeof nested === "string" ? nested : null;
}

function commandExitCode(value: unknown): number {
  const record = asRecord(value);
  const code = record?.exitCode ?? record?.exit_code;
  return typeof code === "number" ? code : NaN;
}

function commandStdout(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.stdout === "string" ? record.stdout : "";
}

function commandStderr(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.stderr === "string" ? record.stderr : "";
}

function createNotificationRecorder() {
  const notifications: CodexAppServerNotification[] = [];
  const waiters = new Set<{
    predicate: (notification: CodexAppServerNotification) => boolean;
    resolve: (notification: CodexAppServerNotification) => void;
    reject: (err: Error) => void;
  }>();

  return {
    notifications,
    onNotification(notification: CodexAppServerNotification): void {
      notifications.push(notification);
      for (const waiter of waiters) {
        let matched = false;
        try {
          matched = waiter.predicate(notification);
        } catch (err) {
          waiters.delete(waiter);
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
          continue;
        }
        if (!matched) continue;
        waiters.delete(waiter);
        waiter.resolve(notification);
      }
    },
    waitFor(
      predicate: (notification: CodexAppServerNotification) => boolean,
      label: string,
      timeoutMs = 180_000,
    ): Promise<CodexAppServerNotification> {
      const existing = notifications.find((notification) => {
        try {
          return predicate(notification);
        } catch {
          return false;
        }
      });
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveWaiter, reject) => {
        const waiter = {
          predicate,
          resolve: (notification: CodexAppServerNotification) => {
            clearTimeout(timer);
            resolveWaiter(notification);
          },
          reject: (err: Error) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
  };
}

async function waitForTurnCompleted(
  recorder: ReturnType<typeof createNotificationRecorder>,
  turnId: string,
): Promise<void> {
  await recorder.waitFor((notification) => {
    const notificationTurnId = readTurnId(notification.params);
    if (notification.method === "turn/failed" && (!notificationTurnId || notificationTurnId === turnId)) {
      throw new Error(`turn failed: ${JSON.stringify(notification.params)}`);
    }
    return notification.method === "turn/completed" && (!notificationTurnId || notificationTurnId === turnId);
  }, `turn/completed for ${turnId}`);
}

describeSmoke("landing Codex app-server auth and sandbox smoke", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("starts command execution with a clean Codex config", async () => {
    const codexBinary = resolveBinary("CODEX_SMOKE_BINARY", "codex");
    const codexVersion = commandOutput(`${shellQuote(codexBinary)} --version || true`);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-landing-codex-clean-smoke-")));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const codexHome = join(root, "clean-codex-home");
    const firstTreeHome = join(workspace, FIRST_TREE_WORKSPACE_MARKER, "outbox-home");
    mkdirSync(firstTreeHome, { recursive: true });
    mkdirSync(outside);
    mkdirSync(codexHome);
    const outsideSentinel = join(outside, "sentinel.txt");
    writeFileSync(outsideSentinel, "outside-secret\n", { mode: 0o600 });

    const cliPath = resolveCliPath();
    setCliBinding({ binName: basename(cliPath), packageName: basename(cliPath) });

    const appServerEnvironment = buildWorkspaceOnlyAppServerEnvironment(
      {
        ...process.env,
        CODEX_HOME: codexHome,
        FIRST_TREE_HOME: firstTreeHome,
        FIRST_TREE_CLI_BIN_DIR: dirname(cliPath),
      },
      workspace,
    );
    const client = await CodexAppServerClient.start({
      binary: codexBinary,
      cwd: workspace,
      env: appServerEnvironment.env,
      appServerArgs: buildLandingCodexAppServerArgs(workspace, appServerEnvironment.codexHome),
      requestTimeoutMs: 120_000,
    });

    try {
      console.log(`[smoke] clean-config codex binary: ${codexBinary}`);
      console.log(`[smoke] clean-config codex version: ${codexVersion}`);
      console.log(`[smoke] clean-config CODEX_HOME  : ${appServerEnvironment.codexHome}`);

      const commandResult = await client.request(
        "command/exec",
        {
          command: [
            "sh",
            "-lc",
            [
              `if cat ${shellQuote(outsideSentinel)} >/dev/null 2>&1; then echo outside=readable; else echo outside=denied; fi`,
              'printf ok > clean-config-smoke.txt && cat clean-config-smoke.txt && printf "\\n"',
            ].join("\n"),
          ],
          cwd: ".",
          permissionProfile: LANDING_CODEX_PERMISSIONS_PROFILE,
          timeoutMs: 20_000,
          outputBytesCap: 65_536,
        },
        60_000,
      );

      const stdout = commandStdout(commandResult);
      console.log(`[smoke] clean-config command stdout:\n${stdout}`);
      expect(commandExitCode(commandResult)).toBe(0);
      expect(stdout).toContain("outside=denied");
      expect(stdout).toMatch(/^ok$/m);
    } finally {
      await client.shutdown();
    }
  }, 120_000);

  it("uses host Codex auth while command execution stays workspace-only", async () => {
    const codexBinary = resolveBinary("CODEX_SMOKE_BINARY", "codex");
    const codexVersion = commandOutput(`${shellQuote(codexBinary)} --version || true`);
    const codexHome = hostCodexHome();
    const authPath = join(codexHome, "auth.json");
    if (!existsSync(authPath)) {
      throw new Error(`Codex auth smoke requires ${authPath} to exist`);
    }

    const root = realpathSync(mkdtempSync(join(tmpdir(), "ft-landing-codex-smoke-")));
    tempRoots.push(root);
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const firstTreeHome = join(workspace, FIRST_TREE_WORKSPACE_MARKER, "outbox-home");
    mkdirSync(firstTreeHome, { recursive: true });
    mkdirSync(outside);
    const outsideSentinel = join(outside, "sentinel.txt");
    writeFileSync(outsideSentinel, "outside-secret\n", { mode: 0o600 });

    const cliPath = resolveCliPath();
    setCliBinding({ binName: basename(cliPath), packageName: basename(cliPath) });

    const appServerEnvironment = buildWorkspaceOnlyAppServerEnvironment(
      {
        ...process.env,
        CODEX_HOME: codexHome,
        FIRST_TREE_HOME: firstTreeHome,
        FIRST_TREE_CLI_BIN_DIR: dirname(cliPath),
        OPENAI_API_KEY: "smoke-openai-secret",
        CODEX_API_KEY: "smoke-codex-secret",
        GITHUB_TOKEN: "smoke-github-secret",
        GH_TOKEN: "smoke-gh-secret",
        FIRST_TREE_RUNTIME_SESSION_TOKEN: "smoke-runtime-secret",
        FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: join(outside, "runtime-token"),
        HTTP_PROXY: "http://user:password@proxy.test:8080",
        HTTPS_PROXY: "http://user:password@proxy.test:8080",
        SSL_CERT_FILE: join(outside, "ca.pem"),
        NODE_EXTRA_CA_CERTS: join(outside, "node-ca.pem"),
      },
      workspace,
    );

    const permissionProfile = buildLandingCodexPermissionProfile(workspace, appServerEnvironment.codexHome);
    const recorder = createNotificationRecorder();
    const client = await CodexAppServerClient.start({
      binary: codexBinary,
      cwd: workspace,
      env: appServerEnvironment.env,
      appServerArgs: buildLandingCodexAppServerArgs(workspace, appServerEnvironment.codexHome),
      requestTimeoutMs: 120_000,
      onNotification: recorder.onNotification,
    });

    try {
      console.log(`[smoke] codex binary: ${codexBinary}`);
      console.log(`[smoke] codex version: ${codexVersion}`);
      console.log(`[smoke] workspace   : ${workspace}`);
      console.log(`[smoke] CODEX_HOME  : ${appServerEnvironment.codexHome}`);

      const commandScript = [
        'printf "codex_auth="',
        'if cat "$CODEX_HOME/auth.json" >/dev/null 2>&1; then echo readable; else echo denied; fi',
        `printf "outside="`,
        `if cat ${shellQuote(outsideSentinel)} >/dev/null 2>&1; then echo readable; else echo denied; fi`,
        'printf "workspace_write="',
        'printf ok > workspace-smoke.txt && cat workspace-smoke.txt && printf "\\n"',
        'printf "leaked_env="',
        [
          "env",
          "|",
          "awk -F= '/^(OPENAI_API_KEY|CODEX_API_KEY|GITHUB_TOKEN|GH_TOKEN|FIRST_TREE_RUNTIME_SESSION_TOKEN|FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)=/ {print $1}'",
          "|",
          "sort",
          "|",
          "paste -sd, -",
        ].join(" "),
      ].join("\n");

      const commandResult = await client.request(
        "command/exec",
        {
          command: ["sh", "-lc", commandScript],
          cwd: ".",
          permissionProfile: LANDING_CODEX_PERMISSIONS_PROFILE,
          timeoutMs: 20_000,
          outputBytesCap: 65_536,
        },
        60_000,
      );

      const stdout = commandStdout(commandResult);
      console.log(`[smoke] command stdout:\n${stdout}`);
      const stderr = commandStderr(commandResult);
      if (stderr.trim()) console.log(`[smoke] command stderr:\n${stderr}`);

      expect(commandExitCode(commandResult)).toBe(0);
      expect(stdout).toContain("codex_auth=denied");
      expect(stdout).toContain("outside=denied");
      expect(stdout).toContain("workspace_write=ok");
      expect(stdout).toMatch(/^leaked_env=$/m);

      if (PROVIDER_CHECK_ENABLED) {
        const threadStart = await client.request(
          "thread/start",
          {
            cwd: workspace,
            approvalPolicy: "never",
            permissions: LANDING_CODEX_PERMISSIONS_PROFILE,
            runtimeWorkspaceRoots: [workspace],
            config: {
              project_root_markers: [FIRST_TREE_WORKSPACE_MARKER],
              permissions: {
                [LANDING_CODEX_PERMISSIONS_PROFILE]: permissionProfile,
              },
            },
            sessionStartSource: "startup",
          },
          120_000,
        );
        const thread = asRecord(asRecord(threadStart)?.thread);
        const threadId = typeof thread?.id === "string" ? thread.id : null;
        expect(threadId).toBeTruthy();

        const turnStart = await client.request(
          "turn/start",
          {
            threadId,
            clientUserMessageId: "landing-codex-auth-smoke",
            input: [
              {
                type: "text",
                text: 'Reply exactly "LANDING_CODEX_AUTH_OK" and do not run any commands.',
              },
            ],
            cwd: workspace,
            approvalPolicy: "never",
            permissions: LANDING_CODEX_PERMISSIONS_PROFILE,
            runtimeWorkspaceRoots: [workspace],
          },
          120_000,
        );
        const turnId = readTurnId(turnStart);
        expect(turnId).toBeTruthy();
        await waitForTurnCompleted(recorder, turnId ?? "");
        console.log(`[smoke] provider turn completed: ${turnId}`);
      }
    } finally {
      await client.shutdown();
    }
  }, 300_000);
});
