/**
 * Tests for the Phase 3a daemon identity resolver.
 *
 * Parity points vs the Rust `identity.rs`:
 *   - `lockKey(profile)` formats as `host__login__profile`
 *   - `hasRequiredScope()` is true iff `repo` or `notifications` is present
 *   - `resolveDaemonIdentity` surfaces a clean error when `gh auth status`
 *     fails rather than leaking the raw stderr
 */

import { describe, expect, it, vi } from "vitest";

import { GhClient } from "../../src/products/breeze/engine/runtime/gh.js";
import {
  identityHasRequiredScope,
  identityLockKey,
  pickActiveIdentityFromAuthStatus,
  resolveDaemonIdentity,
} from "../../src/products/breeze/engine/daemon/identity.js";

function makeGhReturning(stdout: string, status = 0): GhClient {
  const spawn = vi.fn().mockReturnValue({
    pid: 1,
    status,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    output: [],
  });
  return new GhClient({ spawn });
}

describe("identityLockKey", () => {
  it("matches the Rust Identity::lock_key format", () => {
    const key = identityLockKey(
      {
        host: "github.com",
        login: "bingran-you",
        gitProtocol: "https",
        scopes: ["repo"],
      },
      "default",
    );
    expect(key).toBe("github.com__bingran-you__default");
  });
});

describe("identityHasRequiredScope", () => {
  it("is true when `repo` or `notifications` is in scopes", () => {
    expect(
      identityHasRequiredScope({
        host: "github.com",
        login: "x",
        gitProtocol: "https",
        scopes: ["repo", "workflow"],
      }),
    ).toBe(true);
    expect(
      identityHasRequiredScope({
        host: "github.com",
        login: "x",
        gitProtocol: "https",
        scopes: ["notifications"],
      }),
    ).toBe(true);
  });
  it("is false otherwise", () => {
    expect(
      identityHasRequiredScope({
        host: "github.com",
        login: "x",
        gitProtocol: "https",
        scopes: ["workflow"],
      }),
    ).toBe(false);
  });
});

describe("pickActiveIdentityFromAuthStatus", () => {
  it("picks active=true when multiple entries per host", () => {
    const payload = {
      hosts: {
        "github.com": [
          {
            user: "old-login",
            active: false,
            gitProtocol: "ssh",
            scopes: "repo",
          },
          {
            user: "active-login",
            active: true,
            gitProtocol: "https",
            scopes: "repo,workflow",
          },
        ],
      },
    };
    const id = pickActiveIdentityFromAuthStatus(payload, "github.com");
    expect(id?.login).toBe("active-login");
    expect(id?.scopes).toEqual(["repo", "workflow"]);
    expect(id?.gitProtocol).toBe("https");
  });

  it("accepts scope arrays as well as comma strings", () => {
    const payload = {
      hosts: {
        "github.com": {
          user: "x",
          active: true,
          gitProtocol: "https",
          scopes: ["repo", "notifications"],
        },
      },
    };
    const id = pickActiveIdentityFromAuthStatus(payload, "github.com");
    expect(id?.scopes).toEqual(["repo", "notifications"]);
  });

  it("returns null when target host is missing", () => {
    const payload = {
      hosts: { "ghe.other": { user: "x", active: true, scopes: "repo" } },
    };
    expect(pickActiveIdentityFromAuthStatus(payload, "github.com")).toBeNull();
  });
});

describe("resolveDaemonIdentity", () => {
  it("surfaces gh auth failure with an actionable error", () => {
    const gh = makeGhReturning("", 1);
    expect(() => resolveDaemonIdentity({ gh })).toThrow(/gh auth login/u);
  });

  it("round-trips a realistic payload", () => {
    const payload = JSON.stringify({
      hosts: {
        "github.com": {
          user: "bingran-you",
          active: true,
          gitProtocol: "https",
          scopes: "repo,workflow,notifications",
        },
      },
    });
    const gh = makeGhReturning(payload, 0);
    const id = resolveDaemonIdentity({ gh });
    expect(id.host).toBe("github.com");
    expect(id.login).toBe("bingran-you");
    expect(id.gitProtocol).toBe("https");
    expect(id.scopes).toContain("repo");
    expect(identityHasRequiredScope(id)).toBe(true);
  });
});
