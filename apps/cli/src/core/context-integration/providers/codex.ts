import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import semver from "semver";
import type {
  ContextIntegrationProviderDriver,
  ProviderCommandRunner,
  ProviderHookInspectRequest,
  ProviderHookProbe,
  ProviderPluginProbe,
} from "../provider-driver.js";
import { parseProviderVersion, pluginIdentity } from "../provider-driver.js";
import { containsPlugin, defaultProviderCommandRunner, safeProviderProbe } from "./shared.js";

export type CodexHookStateReader = (executable: string, cwd: string) => Promise<unknown>;

export class CodexContextIntegrationDriver implements ContextIntegrationProviderDriver {
  readonly provider = "codex" as const;
  readonly executable: string;
  readonly minimumVersion: string;
  private readonly readHookState: CodexHookStateReader;

  constructor(
    private readonly run: ProviderCommandRunner = defaultProviderCommandRunner,
    options: { executable?: string; minimumVersion?: string; readHookState?: CodexHookStateReader } = {},
  ) {
    this.executable = options.executable ?? "codex";
    this.minimumVersion = options.minimumVersion ?? "0.144.0";
    this.readHookState = options.readHookState ?? readCodexHookState;
  }

  probe(marketplaceName: string, pluginName: string): ProviderPluginProbe {
    const versionResult = safeProviderProbe(() => this.run(this.executable, ["--version"]));
    const version = versionResult ? parseProviderVersion(versionResult.stdout) : null;
    const list = safeProviderProbe(() => JSON.parse(this.run(this.executable, ["plugin", "list", "--json"]).stdout));
    const detectedPlugin = list
      ? containsPlugin(list, pluginName, marketplaceName)
      : { installed: false, enabled: false, installedPath: null, installedVersion: null };
    const plugin = {
      installed: detectedPlugin.installed,
      enabled: detectedPlugin.enabled,
      installedPath:
        detectedPlugin.installedPath ??
        resolveCodexInstalledPluginPath(marketplaceName, pluginName, detectedPlugin.installedVersion),
    };
    const issues: string[] = [];
    if (!versionResult) issues.push("Codex executable was not found.");
    if (version && semver.lt(version, this.minimumVersion)) {
      issues.push(`Codex ${version} is older than the required ${this.minimumVersion}.`);
    }
    if (versionResult && !list) issues.push("Codex Plugin state could not be inspected.");
    return {
      provider: this.provider,
      binaryAvailable: versionResult !== null,
      version,
      compatible: version !== null && semver.gte(version, this.minimumVersion),
      ...plugin,
      issues,
    };
  }

  async inspectHook(request: ProviderHookInspectRequest): Promise<ProviderHookProbe> {
    if (!request.plugin.installed) {
      return {
        trust: "unknown",
        enabled: null,
        source: "unavailable",
        issues: [],
      };
    }
    try {
      const response = await this.readHookState(this.executable, request.cwd);
      return parseCodexHookState(response, pluginIdentity(request.pluginName, request.marketplaceName));
    } catch (error) {
      return {
        trust: "unknown",
        enabled: null,
        source: "unavailable",
        issues: [`Codex Hook state could not be inspected: ${message(error)}`],
      };
    }
  }

  validateMarketplace(_marketplaceRoot: string): void {
    // Codex validates the marketplace and Plugin package during `marketplace add`
    // and `plugin add`. The release build separately runs the canonical Plugin
    // validator before publication.
  }

  install(request: { marketplaceRoot: string; marketplaceName: string; pluginName: string }): ProviderPluginProbe {
    this.uninstall({ marketplaceName: request.marketplaceName, pluginName: request.pluginName });
    this.run(this.executable, ["plugin", "marketplace", "add", request.marketplaceRoot, "--json"]);
    this.run(this.executable, ["plugin", "add", pluginIdentity(request.pluginName, request.marketplaceName), "--json"]);
    const result = this.probe(request.marketplaceName, request.pluginName);
    if (!result.installed || !result.enabled) {
      throw new Error("Codex did not report the First Tree Context Plugin as installed and enabled.");
    }
    return result;
  }

  uninstall(request: { marketplaceName: string; pluginName: string }): void {
    const identity = pluginIdentity(request.pluginName, request.marketplaceName);
    const probe = this.probe(request.marketplaceName, request.pluginName);
    if (!probe.binaryAvailable) {
      throw new Error("Codex is unavailable, so First Tree cannot verify or remove its user-scope Plugin.");
    }
    if (probe.issues.includes("Codex Plugin state could not be inspected.")) {
      throw new Error("Codex Plugin state could not be inspected safely; no uninstall was attempted.");
    }
    if (probe.installed) this.run(this.executable, ["plugin", "remove", identity, "--json"]);
    const marketplaces = JSON.parse(this.run(this.executable, ["plugin", "marketplace", "list", "--json"]).stdout);
    if (JSON.stringify(marketplaces).includes(request.marketplaceName)) {
      this.run(this.executable, ["plugin", "marketplace", "remove", request.marketplaceName, "--json"]);
    }
  }
}

function resolveCodexInstalledPluginPath(
  marketplaceName: string,
  pluginName: string,
  version: string | null,
): string | null {
  if (!version) return null;
  const path = join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "plugins",
    "cache",
    marketplaceName,
    pluginName,
    version,
  );
  return existsSync(path) ? path : null;
}

export function parseCodexHookState(value: unknown, targetPluginId: string): ProviderHookProbe {
  const hooks = collectHookRows(value).filter(
    (row) =>
      Reflect.get(row, "pluginId") === targetPluginId &&
      Reflect.get(row, "eventName") === "sessionStart" &&
      Reflect.get(row, "handlerType") === "command",
  );
  if (hooks.length === 0) {
    return {
      trust: "unknown",
      enabled: null,
      source: "provider_api",
      issues: ["Codex did not discover the First Tree SessionStart Hook."],
    };
  }

  const trustStatuses = hooks.map((hook) => Reflect.get(hook, "trustStatus"));
  const trust = trustStatuses.includes("modified")
    ? "modified"
    : trustStatuses.includes("untrusted")
      ? "review_required"
      : trustStatuses.every((status) => status === "managed")
        ? "provider_managed"
        : trustStatuses.every((status) => status === "trusted" || status === "managed")
          ? "trusted"
          : "unknown";
  const enabledValues = hooks.map((hook) => Reflect.get(hook, "enabled"));
  const enabled = enabledValues.every((item) => item === true)
    ? true
    : enabledValues.some((item) => item === false)
      ? false
      : null;

  return {
    trust,
    enabled,
    source: "provider_api",
    issues: collectHookInspectionIssues(value),
  };
}

function collectHookRows(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  const data = Reflect.get(value, "data");
  if (!Array.isArray(data)) return [];
  const hooks: Array<Record<string, unknown>> = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const entryHooks = Reflect.get(entry, "hooks");
    if (!Array.isArray(entryHooks)) continue;
    for (const hook of entryHooks) {
      if (isRecord(hook)) hooks.push(hook);
    }
  }
  return hooks;
}

function collectHookInspectionIssues(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const data = Reflect.get(value, "data");
  if (!Array.isArray(data)) return [];
  const issues: string[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const warnings = Reflect.get(entry, "warnings");
    if (Array.isArray(warnings)) {
      for (const warning of warnings) {
        if (typeof warning === "string") issues.push(warning);
      }
    }
    const errors = Reflect.get(entry, "errors");
    if (Array.isArray(errors)) {
      for (const error of errors) {
        if (!isRecord(error)) continue;
        const errorMessage = Reflect.get(error, "message");
        if (typeof errorMessage === "string") issues.push(errorMessage);
      }
    }
  }
  return issues;
}

function readCodexHookState(executable: string, cwd: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Codex app-server Hook inspection timed out.")), 5_000);

    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      output.close();
      child.stdin.end();
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(result);
    };

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim();
        finish(
          new Error(
            `Codex app-server exited before returning Hook state (code ${code ?? "none"}, signal ${
              signal ?? "none"
            })${detail ? `: ${detail}` : "."}`,
          ),
        );
      }
    });
    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      const id = Reflect.get(parsed, "id");
      if (id === 1) {
        const rpcError = rpcErrorMessage(parsed);
        if (rpcError) {
          finish(new Error(rpcError));
          return;
        }
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        child.stdin.write(
          `${JSON.stringify({
            id: 2,
            method: "hooks/list",
            params: { cwds: [cwd] },
          })}\n`,
        );
        return;
      }
      if (id === 2) {
        const rpcError = rpcErrorMessage(parsed);
        if (rpcError) finish(new Error(rpcError));
        else finish(undefined, Reflect.get(parsed, "result"));
        return;
      }
      const method = Reflect.get(parsed, "method");
      if ((typeof id === "string" || typeof id === "number") && typeof method === "string") {
        child.stdin.write(
          `${JSON.stringify({
            id,
            error: { code: -32601, message: `First Tree does not handle app-server request ${method}` },
          })}\n`,
        );
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "first-tree",
            title: "First Tree",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      })}\n`,
    );
  });
}

function rpcErrorMessage(value: Record<string, unknown>): string | null {
  const error = Reflect.get(value, "error");
  if (!isRecord(error)) return null;
  const errorMessage = Reflect.get(error, "message");
  return typeof errorMessage === "string" ? errorMessage : "Codex app-server Hook inspection failed.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
