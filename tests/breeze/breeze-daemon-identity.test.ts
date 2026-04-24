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
  pickIdentityFromAuthStatusText,
  resolveDaemonIdentity,
} from "../../src/products/breeze/engine/daemon/identity.js";

function makeGhReturning(
  stdout: string,
  status = 0,
  stderr = "",
): { gh: GhClient; spawn: ReturnType<typeof vi.fn> } {
  const spawn = vi.fn().mockReturnValue({
    pid: 1,
    status,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    output: [],
  });
  return { gh: new GhClient({ spawn }), spawn };
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

describe("pickIdentityFromAuthStatusText", () => {
  it("parses the active account, git protocol, and token scopes", () => {
    const statusText = [
      "github.com",
      "  ✓ Logged in to github.com account active-login (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: ssh",
      "  - Token scopes: 'repo', 'workflow'",
      "",
    ].join("\n");

    const id = pickIdentityFromAuthStatusText(statusText, "github.com");
    expect(id?.login).toBe("active-login");
    expect(id?.scopes).toEqual(["repo", "workflow"]);
    expect(id?.gitProtocol).toBe("ssh");
  });

  it("accepts unquoted scope strings as well as quoted ones", () => {
    const statusText = [
      "github.com",
      "  ✓ Logged in to github.com account x (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: https",
      "  - Token scopes: repo,notifications",
      "",
    ].join("\n");

    const id = pickIdentityFromAuthStatusText(statusText, "github.com");
    expect(id?.scopes).toEqual(["repo", "notifications"]);
  });

  it("returns null when the login line is missing for the target host", () => {
    const statusText = [
      "github.com",
      "  - Active account: true",
      "  - Token scopes: repo",
      "",
    ].join("\n");
    expect(pickIdentityFromAuthStatusText(statusText, "github.com")).toBeNull();
  });
});

describe("resolveDaemonIdentity", () => {
  it("surfaces gh auth failure with an actionable error", () => {
    const { gh } = makeGhReturning("", 1, "not logged in");
    expect(() => resolveDaemonIdentity({ gh })).toThrow(/gh auth login/u);
  });

  it("parses a realistic auth status response without using --json", () => {
    const statusText = [
      "github.com",
      "  ✓ Logged in to github.com account bingran-you (keyring)",
      "  - Active account: true",
      "  - Git operations protocol: https",
      "  - Token scopes: 'repo', 'workflow', 'notifications'",
      "",
    ].join("\n");
    const { gh, spawn } = makeGhReturning(statusText, 0);
    const id = resolveDaemonIdentity({ gh });
    expect(id.host).toBe("github.com");
    expect(id.login).toBe("bingran-you");
    expect(id.gitProtocol).toBe("https");
    expect(id.scopes).toContain("repo");
    expect(identityHasRequiredScope(id)).toBe(true);
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "auth",
      "status",
      "--active",
      "--hostname",
      "github.com",
    ]);
  });
});
