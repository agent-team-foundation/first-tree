import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDaemonEnv, parseDaemonEnv } from "../core/daemon-env.js";

describe("parseDaemonEnv", () => {
  it("parses KEY=VALUE lines, skipping blanks and comments", () => {
    expect(parseDaemonEnv("HTTP_PROXY=http://127.0.0.1:7897\n\n# a comment\nNO_PROXY=localhost")).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7897",
      NO_PROXY: "localhost",
    });
  });

  it("tolerates an `export ` prefix and surrounding quotes", () => {
    expect(
      parseDaemonEnv(`export HTTPS_PROXY="http://user:pa ss@host:1"\nALL_PROXY='socks5://127.0.0.1:7891'`),
    ).toEqual({
      HTTPS_PROXY: "http://user:pa ss@host:1",
      ALL_PROXY: "socks5://127.0.0.1:7891",
    });
  });

  it("skips malformed lines rather than throwing", () => {
    expect(parseDaemonEnv("not-an-assignment\n=novalue\n9BAD=x\nGOOD=ok")).toEqual({ GOOD: "ok" });
  });
});

describe("loadDaemonEnv", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `ft-daemon-env-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    envPath = join(dir, "daemon.env");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fills gaps in the target env and reports applied keys", () => {
    writeFileSync(envPath, "HTTP_PROXY=http://proxy:1\nHTTPS_PROXY=http://proxy:2\n");
    const env: NodeJS.ProcessEnv = {};
    expect(loadDaemonEnv(envPath, env).sort()).toEqual(["HTTPS_PROXY", "HTTP_PROXY"].sort());
    expect(env.HTTP_PROXY).toBe("http://proxy:1");
    expect(env.HTTPS_PROXY).toBe("http://proxy:2");
  });

  it("never clobbers a value already present in the environment", () => {
    writeFileSync(envPath, "HTTP_PROXY=http://from-file\n");
    const env: NodeJS.ProcessEnv = { HTTP_PROXY: "http://live-value" };
    expect(loadDaemonEnv(envPath, env)).toEqual([]);
    expect(env.HTTP_PROXY).toBe("http://live-value");
  });

  it("is a clean no-op when the file is missing", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadDaemonEnv(join(dir, "nope.env"), env)).toEqual([]);
    expect(env).toEqual({});
  });
});
