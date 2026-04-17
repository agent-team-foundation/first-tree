/**
 * Identity cache: TTL, staleness, refresh-on-miss. The `gh api /user`
 * call is stubbed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_IDENTITY_TTL_MS,
  resolveIdentity,
} from "../src/products/breeze/engine/runtime/identity.js";
import { GhClient } from "../src/products/breeze/engine/runtime/gh.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "breeze-identity-"));
}

function makeMockGh(stdout: string): GhClient {
  const spawn = vi.fn().mockReturnValue({
    pid: 1,
    status: 0,
    signal: null,
    stdout: Buffer.from(stdout, "utf-8"),
    stderr: Buffer.alloc(0),
    output: [],
  });
  return new GhClient({ spawn });
}

describe("resolveIdentity", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("fetches fresh identity when no cache exists", () => {
    dir = mkTmp();
    const cachePath = join(dir, "identity.json");
    const gh = makeMockGh('{"login":"alice"}');
    const identity = resolveIdentity({
      cachePath,
      gh,
      now: () => 1_700_000_000_000,
      host: "github.com",
    });
    expect(identity.login).toBe("alice");
    expect(identity.host).toBe("github.com");
    expect(identity.fetched_at_ms).toBe(1_700_000_000_000);
    // Cache was written.
    const onDisk = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(onDisk.login).toBe("alice");
  });

  it("uses cache when fresh (< TTL)", () => {
    dir = mkTmp();
    const cachePath = join(dir, "identity.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        login: "bob",
        host: "github.com",
        fetched_at_ms: 1_700_000_000_000,
      }),
      "utf-8",
    );
    // Force gh to error — shouldn't be called.
    const spawn = vi.fn().mockImplementation(() => {
      throw new Error("should not be called");
    });
    const gh = new GhClient({ spawn });
    const identity = resolveIdentity({
      cachePath,
      gh,
      now: () => 1_700_000_000_000 + DEFAULT_IDENTITY_TTL_MS - 1000,
    });
    expect(identity.login).toBe("bob");
  });

  it("refetches when cache is stale (>= TTL)", () => {
    dir = mkTmp();
    const cachePath = join(dir, "identity.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        login: "bob",
        host: "github.com",
        fetched_at_ms: 1_700_000_000_000,
      }),
      "utf-8",
    );
    const gh = makeMockGh('{"login":"carol"}');
    const identity = resolveIdentity({
      cachePath,
      gh,
      now: () => 1_700_000_000_000 + DEFAULT_IDENTITY_TTL_MS + 1,
    });
    expect(identity.login).toBe("carol");
  });

  it("treats malformed cache as a miss", () => {
    dir = mkTmp();
    const cachePath = join(dir, "identity.json");
    writeFileSync(cachePath, "not json", "utf-8");
    const gh = makeMockGh('{"login":"dave"}');
    const identity = resolveIdentity({
      cachePath,
      gh,
      now: () => 1_700_000_000_000,
    });
    expect(identity.login).toBe("dave");
  });
});
