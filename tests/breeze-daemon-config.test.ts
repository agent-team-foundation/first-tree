/**
 * Tests for the Phase 3a daemon config loader.
 *
 * Verifies the priority pipeline documented in `core/config.ts`:
 *   CLI overrides > env vars > yaml > defaults.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DAEMON_CONFIG_DEFAULTS,
  breezeDaemonConfigSearchPaths,
  loadBreezeDaemonConfig,
} from "../src/products/breeze/engine/runtime/config.js";

describe("loadBreezeDaemonConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "breeze-daemon-cfg-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("falls back to defaults when nothing is configured", () => {
    const cfg = loadBreezeDaemonConfig({
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
    const cfg = loadBreezeDaemonConfig({
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
    const cfg = loadBreezeDaemonConfig({
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
      BREEZE_POLL_INTERVAL_SECS: "120",
      BREEZE_HTTP_PORT: "4242",
    };
    const cfg = loadBreezeDaemonConfig({
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
      BREEZE_POLL_INTERVAL_SECS: "120",
      BREEZE_HTTP_PORT: "4242",
    };
    const cfg = loadBreezeDaemonConfig({
      env: (name) => envBag[name],
      configPath,
      cliOverrides: { pollIntervalSec: 5, httpPort: 1234 },
    });
    expect(cfg.pollIntervalSec).toBe(5);
    expect(cfg.httpPort).toBe(1234);
  });

  it("searches ~/.first-tree/breeze/ before ~/.breeze/", () => {
    const paths = breezeDaemonConfigSearchPaths(tmp);
    expect(paths[0]).toBe(join(tmp, ".first-tree", "breeze", "config.yaml"));
    expect(paths[1]).toBe(join(tmp, ".breeze", "config.yaml"));
  });

  it("honors BREEZE_INBOX_POLL_INTERVAL_SECS as a fallback env key", () => {
    const envBag: Record<string, string> = {
      BREEZE_INBOX_POLL_INTERVAL_SECS: "15",
    };
    const cfg = loadBreezeDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });
    expect(cfg.pollIntervalSec).toBe(15);
  });

  it("GH_HOST is an accepted host fallback", () => {
    const envBag: Record<string, string> = { GH_HOST: "ghe.internal" };
    const cfg = loadBreezeDaemonConfig({
      env: (name) => envBag[name],
      configPath: join(tmp, "no-such-file.yaml"),
    });
    expect(cfg.host).toBe("ghe.internal");
  });

  it("rejects malformed yaml with a descriptive error", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, "poll_interval_sec: : :\n", "utf-8");
    expect(() =>
      loadBreezeDaemonConfig({
        env: () => undefined,
        configPath,
      }),
    ).toThrow(/failed to parse breeze daemon config/u);
  });

  it("ignores invalid log levels in yaml", () => {
    const configPath = join(tmp, "config.yaml");
    writeFileSync(configPath, `log_level: silly\n`, "utf-8");
    const cfg = loadBreezeDaemonConfig({
      env: () => undefined,
      configPath,
    });
    expect(cfg.logLevel).toBe("info"); // fell back to default
  });

  it("skips yaml overlay when the file does not exist", () => {
    const cfg = loadBreezeDaemonConfig({
      env: () => undefined,
      configPath: join(tmp, "missing.yaml"),
    });
    expect(cfg).toEqual(DAEMON_CONFIG_DEFAULTS);
  });

  it("accepts first existing yaml in the search order (first-tree wins)", () => {
    const primaryDir = join(tmp, ".first-tree", "breeze");
    const legacyDir = join(tmp, ".breeze");
    writeFileSync(
      `${tmp}/first.tmp`, // dummy to ensure tmp exists
      "",
      "utf-8",
    );
    // mkdir -p primary + legacy via real fs
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { mkdirSync, writeFileSync: wfs } = require("node:fs") as typeof import("node:fs");
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    wfs(join(primaryDir, "config.yaml"), "poll_interval_sec: 7\n", "utf-8");
    wfs(join(legacyDir, "config.yaml"), "poll_interval_sec: 99\n", "utf-8");
    const cfg = loadBreezeDaemonConfig({
      env: () => undefined,
      homeDir: () => tmp,
    });
    expect(cfg.pollIntervalSec).toBe(7);
  });
});
