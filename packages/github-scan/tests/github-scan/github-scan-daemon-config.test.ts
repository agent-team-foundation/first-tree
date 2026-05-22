/**
 * Tests for the Phase 3a daemon config loader.
 *
 * Verifies the priority pipeline documented in `runtime/config.ts`:
 *   CLI overrides > env vars > yaml > defaults.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_CONFIG_DEFAULTS,
  githubScanDaemonConfigSearchPaths,
  loadGitHubScanDaemonConfig,
} from "../../src/github-scan/engine/runtime/config.js";

describe("loadGitHubScanDaemonConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "github-scan-daemon-cfg-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("falls back to defaults when nothing is configured", () => {
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      fileExists: () => false,
      readFile: () => "",
      homeDir: () => tmp,
    });
    expect(cfg).toEqual(DAEMON_CONFIG_DEFAULTS);
    expect(cfg.pollIntervalSec).toBe(60);
    expect(cfg.httpPort).toBe(7878);
    expect(cfg.logLevel).toBe("info");
    expect(cfg.host).toBe("github.com");
  });

  it("reads yaml over defaults (snake_case keys)", () => {
    const yaml = `poll_interval_sec: 30
task_timeout_sec: 300
log_level: debug
http_port: 9191
host: ghe.example.com
`;
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, yaml, "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.pollIntervalSec).toBe(30);
    expect(cfg.taskTimeoutSec).toBe(300);
    expect(cfg.logLevel).toBe("debug");
    expect(cfg.httpPort).toBe(9191);
    expect(cfg.host).toBe("ghe.example.com");
  });

  it("accepts camelCase yaml keys too (forward-compat)", () => {
    const yaml = `pollIntervalSec: 45
httpPort: 8080
`;
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, yaml, "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.pollIntervalSec).toBe(45);
    expect(cfg.httpPort).toBe(8080);
  });

  it("env vars beat yaml", () => {
    const yaml = `poll_interval_sec: 30\nhttp_port: 9191\n`;
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, yaml, "utf-8");
    const envBag: Record<string, string> = {
      GITHUB_SCAN_POLL_INTERVAL_SECS: "120",
      GITHUB_SCAN_HTTP_PORT: "4242",
    };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath,
    });
    expect(cfg.pollIntervalSec).toBe(120);
    expect(cfg.httpPort).toBe(4242);
  });

  it("CLI overrides beat env and yaml", () => {
    const yaml = `poll_interval_sec: 30\nhttp_port: 9191\n`;
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, yaml, "utf-8");
    const envBag: Record<string, string> = {
      GITHUB_SCAN_POLL_INTERVAL_SECS: "120",
      GITHUB_SCAN_HTTP_PORT: "4242",
    };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath,
      cliOverrides: { pollIntervalSec: 5, httpPort: 1234 },
    });
    expect(cfg.pollIntervalSec).toBe(5);
    expect(cfg.httpPort).toBe(1234);
  });

  it("searches ~/.first-tree/github-scan/config.yaml", () => {
    const paths = githubScanDaemonConfigSearchPaths(tmp);
    expect(paths).toEqual([join(tmp, ".first-tree/github-scan", "config.yaml")]);
  });

  it("searches GITHUB_SCAN_DIR/config.yaml when GITHUB_SCAN_DIR is set", () => {
    const githubScanDir = join(tmp, "custom-github-scan");
    const paths = githubScanDaemonConfigSearchPaths(tmp, githubScanDir);
    expect(paths).toEqual([join(githubScanDir, "config.yaml")]);
  });

  it("honors GITHUB_SCAN_INBOX_POLL_INTERVAL_SECS as a fallback env key", () => {
    const envBag: Record<string, string> = {
      GITHUB_SCAN_INBOX_POLL_INTERVAL_SECS: "15",
    };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });
    expect(cfg.pollIntervalSec).toBe(15);
  });

  it("GH_HOST is an accepted host fallback", () => {
    const envBag: Record<string, string> = { GH_HOST: "ghe.internal" };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });
    expect(cfg.host).toBe("ghe.internal");
  });

  it("rejects malformed yaml with a descriptive error", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "poll_interval_sec: : :\n", "utf-8");
    expect(() =>
      loadGitHubScanDaemonConfig({
        env: () => undefined,
        configPath,
      }),
    ).toThrow(/failed to parse github-scan daemon config/u);
  });

  it("ignores invalid log levels in yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `log_level: silly\n`, "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.logLevel).toBe("info"); // fell back to default
  });

  it("skips yaml overlay when the file does not exist", () => {
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath: join(tmp, "missing.yaml"),
    });
    expect(cfg).toEqual(DAEMON_CONFIG_DEFAULTS);
  });

  it("defaults maxParallel to 20 and searchLimit to 10", () => {
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      fileExists: () => false,
      readFile: () => "",
      homeDir: () => tmp,
    });
    expect(cfg.maxParallel).toBe(20);
    expect(cfg.searchLimit).toBe(10);
  });

  it("reads max_parallel and search_limit from yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "max_parallel: 4\nsearch_limit: 50\n", "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.maxParallel).toBe(4);
    expect(cfg.searchLimit).toBe(50);
  });

  it("env vars override yaml for concurrency knobs", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "max_parallel: 4\nsearch_limit: 50\n", "utf-8");
    const envBag: Record<string, string> = {
      GITHUB_SCAN_MAX_PARALLEL: "30",
      GITHUB_SCAN_SEARCH_LIMIT: "25",
    };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath,
    });
    expect(cfg.maxParallel).toBe(30);
    expect(cfg.searchLimit).toBe(25);
  });

  it("CLI overrides beat env for concurrency knobs", () => {
    const envBag: Record<string, string> = {
      GITHUB_SCAN_MAX_PARALLEL: "30",
      GITHUB_SCAN_SEARCH_LIMIT: "25",
    };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such.yaml"),
      cliOverrides: { maxParallel: 100, searchLimit: 5 },
    });
    expect(cfg.maxParallel).toBe(100);
    expect(cfg.searchLimit).toBe(5);
  });

  it("rejects non-positive maxParallel / searchLimit overrides silently", () => {
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath: join(tmp, "no-such.yaml"),
      cliOverrides: { maxParallel: -1, searchLimit: 0 },
    });
    // Fall back to defaults.
    expect(cfg.maxParallel).toBe(20);
    expect(cfg.searchLimit).toBe(10);
  });

  it("accepts the first existing yaml in the search order", () => {
    const primaryDir = join(tmp, ".first-tree/github-scan");
    writeFileSync(
      `${tmp}/first.tmp`, // dummy to ensure tmp exists
      "",
      "utf-8",
    );
    // mkdir -p primary via real fs
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mkdirSync, writeFileSync: wfs } = require("node:fs") as typeof import("node:fs");
    mkdirSync(primaryDir, { recursive: true });
    wfs(join(primaryDir, "config.yaml"), "poll_interval_sec: 7\n", "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      homeDir: () => tmp,
    });
    expect(cfg.pollIntervalSec).toBe(7);
  });

  it("uses GITHUB_SCAN_DIR as the config root for the default search path", () => {
    const githubScanDir = join(tmp, "alt-github-scan");
    const configPath = join(githubScanDir, "config.yaml");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(githubScanDir, { recursive: true });
    writeFileSync(configPath, "http_port: 9090\n", "utf-8");

    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => (name === "GITHUB_SCAN_DIR" ? githubScanDir : undefined),
      homeDir: () => "/ignored-home",
    });

    expect(cfg.httpPort).toBe(9090);
  });

  // ------------------------------------------------------------------
  // Issue #360: --agent-login (CLI flag / env / yaml) resolution.
  //
  // The four-tier order matches every other config knob: CLI > env >
  // yaml > undefined (callers fall back to `gh auth` identity).
  // ------------------------------------------------------------------

  it("agentLogin defaults to undefined (gh auth fallback handled by caller)", () => {
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      fileExists: () => false,
      readFile: () => "",
      homeDir: () => tmp,
    });
    expect(cfg.agentLogin).toBeUndefined();
  });

  it("reads agent_login from yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "agent_login: yaml-bot\n", "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.agentLogin).toBe("yaml-bot");
  });

  it("accepts agentLogin (camelCase) from yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "agentLogin: yaml-bot\n", "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.agentLogin).toBe("yaml-bot");
  });

  it("GITHUB_SCAN_AGENT_LOGIN env beats yaml agent_login", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "agent_login: yaml-bot\n", "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => (name === "GITHUB_SCAN_AGENT_LOGIN" ? "env-bot" : undefined),
      configPath,
    });
    expect(cfg.agentLogin).toBe("env-bot");
  });

  it("CLI --agent-login beats env and yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "agent_login: yaml-bot\n", "utf-8");
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => (name === "GITHUB_SCAN_AGENT_LOGIN" ? "env-bot" : undefined),
      configPath,
      cliOverrides: { agentLogin: "cli-bot" },
    });
    expect(cfg.agentLogin).toBe("cli-bot");
  });

  it("empty CLI agentLogin does not clobber env/yaml", () => {
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => (name === "GITHUB_SCAN_AGENT_LOGIN" ? "env-bot" : undefined),
      configPath: join(tmp, "no-such-file.yaml"),
      cliOverrides: { agentLogin: "" },
    });
    expect(cfg.agentLogin).toBe("env-bot");
  });

  it("reads the bound tree repo from env", () => {
    const envBag: Record<string, string> = {
      FIRST_TREE_GITHUB_SCAN_TREE_REPO: "agent-team-foundation/first-tree-context",
    };
    const cfg = loadGitHubScanDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });

    expect(cfg.treeRepo).toBe("agent-team-foundation/first-tree-context");
  });
});
