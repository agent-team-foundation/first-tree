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
  autoDaemonConfigSearchPaths,
  loadAutoDaemonConfig,
} from "../../src/runtime/config.js";

describe("loadAutoDaemonConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "auto-daemon-cfg-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("falls back to defaults when nothing is configured", () => {
    const cfg = loadAutoDaemonConfig({
      env: () => undefined,
      fileExists: () => false,
      readFile: () => "",
      homeDir: () => tmp,
    });
    expect(cfg).toEqual(DAEMON_CONFIG_DEFAULTS);
    expect(cfg.pollIntervalSec).toBe(60);
    expect(cfg.httpPort).toBe(7879);
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
    const cfg = loadAutoDaemonConfig({
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
    const cfg = loadAutoDaemonConfig({
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
      AUTO_POLL_INTERVAL_SECS: "120",
      AUTO_HTTP_PORT: "4242",
    };
    const cfg = loadAutoDaemonConfig({
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
      AUTO_POLL_INTERVAL_SECS: "120",
      AUTO_HTTP_PORT: "4242",
    };
    const cfg = loadAutoDaemonConfig({
      env: (name) => envBag[name],
      configPath,
      cliOverrides: { pollIntervalSec: 5, httpPort: 1234 },
    });
    expect(cfg.pollIntervalSec).toBe(5);
    expect(cfg.httpPort).toBe(1234);
  });

  it("returns the canonical ~/.first-tree/auto path", () => {
    const paths = autoDaemonConfigSearchPaths(tmp);
    expect(paths).toEqual([join(tmp, ".first-tree", "auto", "config.yaml")]);
  });

  it("prepends $AUTO_DIR/config.yaml when AUTO_DIR is set", () => {
    const paths = autoDaemonConfigSearchPaths(
      tmp,
      (name) => (name === "AUTO_DIR" ? "/tmp/custom-auto" : undefined),
    );
    expect(paths).toEqual([
      join("/tmp/custom-auto", "config.yaml"),
      join(tmp, ".first-tree", "auto", "config.yaml"),
    ]);
  });

  it("loads config.yaml from $AUTO_DIR via the search path", () => {
    const yaml = "http_port: 4242\n";
    writeFileSync(join(tmp, "config.yaml"), yaml, "utf-8");
    const cfg = loadAutoDaemonConfig({
      env: (name) => (name === "AUTO_DIR" ? tmp : undefined),
      homeDir: () => "/never-touched",
    });
    expect(cfg.httpPort).toBe(4242);
  });

  it("honors AUTO_INBOX_POLL_INTERVAL_SECS as a fallback env key", () => {
    const envBag: Record<string, string> = {
      AUTO_INBOX_POLL_INTERVAL_SECS: "15",
    };
    const cfg = loadAutoDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });
    expect(cfg.pollIntervalSec).toBe(15);
  });

  it("GH_HOST is an accepted host fallback", () => {
    const envBag: Record<string, string> = { GH_HOST: "ghe.internal" };
    const cfg = loadAutoDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });
    expect(cfg.host).toBe("ghe.internal");
  });

  it("rejects malformed yaml with a descriptive error", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "poll_interval_sec: : :\n", "utf-8");
    expect(() =>
      loadAutoDaemonConfig({
        env: () => undefined,
        configPath,
      }),
    ).toThrow(/failed to parse auto daemon config/u);
  });

  it("ignores invalid log levels in yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `log_level: silly\n`, "utf-8");
    const cfg = loadAutoDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.logLevel).toBe("info"); // fell back to default
  });

  it("skips yaml overlay when the file does not exist", () => {
    const cfg = loadAutoDaemonConfig({
      env: () => undefined,
      configPath: join(tmp, "missing.yaml"),
    });
    expect(cfg).toEqual(DAEMON_CONFIG_DEFAULTS);
  });

  it("defaults maxParallel to 20 and searchLimit to 10", () => {
    const cfg = loadAutoDaemonConfig({
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
    writeFileSync(
      configPath,
      "max_parallel: 4\nsearch_limit: 50\n",
      "utf-8",
    );
    const cfg = loadAutoDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.maxParallel).toBe(4);
    expect(cfg.searchLimit).toBe(50);
  });

  it("env vars override yaml for concurrency knobs", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(
      configPath,
      "max_parallel: 4\nsearch_limit: 50\n",
      "utf-8",
    );
    const envBag: Record<string, string> = {
      AUTO_MAX_PARALLEL: "30",
      AUTO_SEARCH_LIMIT: "25",
    };
    const cfg = loadAutoDaemonConfig({
      env: (name) => envBag[name],
      configPath,
    });
    expect(cfg.maxParallel).toBe(30);
    expect(cfg.searchLimit).toBe(25);
  });

  it("CLI overrides beat env for concurrency knobs", () => {
    const envBag: Record<string, string> = {
      AUTO_MAX_PARALLEL: "30",
      AUTO_SEARCH_LIMIT: "25",
    };
    const cfg = loadAutoDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such.yaml"),
      cliOverrides: { maxParallel: 100, searchLimit: 5 },
    });
    expect(cfg.maxParallel).toBe(100);
    expect(cfg.searchLimit).toBe(5);
  });

  it("rejects non-positive maxParallel / searchLimit overrides silently", () => {
    const cfg = loadAutoDaemonConfig({
      env: () => undefined,
      configPath: join(tmp, "no-such.yaml"),
      cliOverrides: { maxParallel: -1, searchLimit: 0 },
    });
    // Fall back to defaults.
    expect(cfg.maxParallel).toBe(20);
    expect(cfg.searchLimit).toBe(10);
  });

  it("loads yaml from the canonical ~/.first-tree/auto path", () => {
    const primaryDir = join(tmp, ".first-tree", "auto");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mkdirSync, writeFileSync: wfs } = require("node:fs") as typeof import("node:fs");
    mkdirSync(primaryDir, { recursive: true });
    wfs(join(primaryDir, "config.yaml"), "poll_interval_sec: 7\n", "utf-8");
    const cfg = loadAutoDaemonConfig({
      env: () => undefined,
      homeDir: () => tmp,
    });
    expect(cfg.pollIntervalSec).toBe(7);
  });
});
