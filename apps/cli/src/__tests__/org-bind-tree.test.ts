import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Coverage for `first-tree org bind-tree` (Phase B handoff #7). The
 * command is wired to Step 3 onboarding agents that just created a fresh
 * context-tree repo and need the server to record the binding under
 * `orgs/:orgId/settings/context_tree`. We assert:
 *
 *   1. URL validation rejects malformed input with `INVALID_URL` and exits 2.
 *   2. `--org <id>` short-circuits the `/me` lookup and uses the explicit id.
 *   3. Without `--org`, a single-membership user auto-picks; multi-membership
 *      without a default org refuses with `AMBIGUOUS_ORG` rather than guessing.
 */

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

class ProcessExit extends Error {
  constructor(public exitCode: number) {
    super(`__process_exit__:${exitCode}`);
    this.name = "ProcessExit";
  }
}

describe("org bind-tree CLI", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalServerUrl: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  let exitCalls: number[];
  let originalExit: typeof process.exit;
  let stderr: string;
  let stdout: string;
  let originalStderrWrite: typeof process.stderr.write;
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    testHome = join(tmpdir(), `ft-first-tree-bind-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testHome, "config"), { recursive: true });
    writeFileSync(
      join(testHome, "config", "credentials.json"),
      JSON.stringify({
        // exp ~30 minutes in the future so ensureFreshAccessToken returns
        // it without firing /auth/refresh.
        accessToken: makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 }),
        refreshToken: "refresh-xyz",
        serverUrl: "http://first-tree.test",
      }),
    );
    writeFileSync(join(testHome, "config", "client.yaml"), "server:\n  url: http://first-tree.test\n");

    originalHome = process.env.FIRST_TREE_HOME;
    originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
    process.env.FIRST_TREE_HOME = testHome;
    delete process.env.FIRST_TREE_SERVER_URL;

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Convert process.exit into a thrown sentinel so the action can be
    // awaited. Commander surfaces action errors via the returned promise.
    exitCalls = [];
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new ProcessExit(code ?? 0);
    }) as typeof process.exit;

    stderr = "";
    stdout = "";
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    // resolver's defaultHome() / defaultConfigDir() read env on every
    // call. Reset module cache so any path memoized in upper layers
    // (e.g. const at module load in a downstream caller) is recomputed
    // against this test's freshly set FIRST_TREE_HOME.
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;

    if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
    else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;

    rmSync(testHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  });

  async function buildProgram(): Promise<Command> {
    const program = new Command();
    program.exitOverride();
    const { registerOrgCommands } = await import("../commands/org/index.js");
    registerOrgCommands(program);
    return program;
  }

  function firstErrorEnvelope(): { ok: false; error: { code: string; message: string } } | null {
    // print.fail writes a JSON envelope per line on stderr. The action wraps
    // its body in a generic try/catch that turns any caught throw into a
    // second `UNEXPECTED` envelope; in production `process.exit` aborts
    // before that catch fires, but here `process.exit` is mocked to throw
    // so the catch runs. Read the FIRST envelope so assertions reflect the
    // original failure code, not the catch-all repackaging.
    for (const line of stderr.split("\n")) {
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && parsed.ok === false) return parsed;
      } catch {
        // Not a JSON line, keep scanning.
      }
    }
    return null;
  }

  function firstExitCode(): number | undefined {
    return exitCalls[0];
  }

  it("rejects a malformed URL with INVALID_URL and exits 2", async () => {
    const program = await buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(["node", "first-tree", "org", "bind-tree", "not-a-url"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstExitCode()).toBe(2);

    const envelope = firstErrorEnvelope();
    expect(envelope?.error.code).toBe("INVALID_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty URL with INVALID_URL and exits 2", async () => {
    const program = await buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(["node", "first-tree", "org", "bind-tree", "   "]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstExitCode()).toBe(2);
    expect(firstErrorEnvelope()?.error.code).toBe("INVALID_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-http URL schemes with INVALID_URL and exits 2", async () => {
    const program = await buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(["node", "first-tree", "org", "bind-tree", "ssh://github.com/acme/tree.git"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstExitCode()).toBe(2);
    expect(firstErrorEnvelope()?.error.message).toContain("URL scheme must be http or https");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with --org, PUTs to /orgs/:orgId/settings/context_tree without consulting /me", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const program = await buildProgram();
    await program.parseAsync([
      "node",
      "first-tree",
      "org",
      "bind-tree",
      "https://github.com/acme/tree",
      "--org",
      "org-explicit",
    ]);

    // Single fetch — no /me round-trip when --org is provided.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://first-tree.test/api/v1/orgs/org-explicit/settings/context_tree");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ repo: "https://github.com/acme/tree" });

    const envelope = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      data: { orgId: string; repo: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ orgId: "org-explicit", repo: "https://github.com/acme/tree" });
  });

  it("with --org and --branch, PUTs an exact repo and branch without consulting /me", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const program = await buildProgram();
    await program.parseAsync([
      "node",
      "first-tree",
      "org",
      "bind-tree",
      "https://github.com/acme/tree",
      "--org",
      "org-explicit",
      "--branch",
      "main",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://first-tree.test/api/v1/orgs/org-explicit/settings/context_tree");
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      repo: "https://github.com/acme/tree",
      branch: "main",
    });

    const envelope = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      ok: boolean;
      data: { branch: string; orgId: string; repo: string };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ orgId: "org-explicit", repo: "https://github.com/acme/tree", branch: "main" });
  });

  it("rejects invalid --branch before the PUT", async () => {
    const program = await buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync([
        "node",
        "first-tree",
        "org",
        "bind-tree",
        "https://github.com/acme/tree",
        "--org",
        "org-explicit",
        "--branch",
        "feature..next",
      ]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstExitCode()).toBe(2);
    expect(firstErrorEnvelope()?.error.code).toBe("INVALID_BRANCH");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("URL-encodes the org id in the PUT path", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const program = await buildProgram();
    await program.parseAsync([
      "node",
      "first-tree",
      "org",
      "bind-tree",
      "https://github.com/acme/tree",
      "--org",
      "org with space",
    ]);

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://first-tree.test/api/v1/orgs/org%20with%20space/settings/context_tree");
  });

  it("without --org, single-membership user auto-picks the org", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return new Response(
          JSON.stringify({
            memberships: [{ organizationId: "only-one", role: "admin" }],
            defaultOrganizationId: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });

    const program = await buildProgram();
    await program.parseAsync(["node", "first-tree", "org", "bind-tree", "https://github.com/acme/tree"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const putUrl = String(fetchMock.mock.calls[1]?.[0] ?? "");
    expect(putUrl).toBe("http://first-tree.test/api/v1/orgs/only-one/settings/context_tree");
  });

  it("without --org and multiple orgs without a default, fails AMBIGUOUS_ORG and does not PUT", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return new Response(
          JSON.stringify({
            memberships: [
              { organizationId: "org-a", role: "admin" },
              { organizationId: "org-b", role: "admin" },
            ],
            defaultOrganizationId: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    const program = await buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync(["node", "first-tree", "org", "bind-tree", "https://github.com/acme/tree"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstErrorEnvelope()?.error.code).toBe("AMBIGUOUS_ORG");
    // /me only — no PUT attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without --org, surfaces /me failures and empty memberships", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const meFailProgram = await buildProgram();
    let caught: unknown;
    try {
      await meFailProgram.parseAsync(["node", "first-tree", "org", "bind-tree", "https://github.com/acme/tree"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstErrorEnvelope()?.error.code).toBe("ME_FAILED");

    fetchMock.mockReset();
    stderr = "";
    exitCalls = [];
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ memberships: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const noOrgProgram = await buildProgram();
    try {
      await noOrgProgram.parseAsync(["node", "first-tree", "org", "bind-tree", "https://github.com/acme/tree"]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    expect(firstErrorEnvelope()?.error.code).toBe("NO_ORG");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("without --org but with defaultOrganizationId, picks the default", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return new Response(
          JSON.stringify({
            memberships: [
              { organizationId: "org-a", role: "admin" },
              { organizationId: "org-default", role: "admin" },
            ],
            defaultOrganizationId: "org-default",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });

    const program = await buildProgram();
    await program.parseAsync(["node", "first-tree", "org", "bind-tree", "https://github.com/acme/tree"]);

    const putUrl = String(fetchMock.mock.calls[1]?.[0] ?? "");
    expect(putUrl).toBe("http://first-tree.test/api/v1/orgs/org-default/settings/context_tree");
  });

  it("surfaces server errors as PUT_FAILED with the response body", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden: not an admin", { status: 403 }));

    const program = await buildProgram();
    let caught: unknown;
    try {
      await program.parseAsync([
        "node",
        "first-tree",
        "org",
        "bind-tree",
        "https://github.com/acme/tree",
        "--org",
        "org-x",
      ]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProcessExit);
    const envelope = firstErrorEnvelope();
    expect(envelope?.error.code).toBe("PUT_FAILED");
    expect(envelope?.error.message).toContain("403");
    expect(envelope?.error.message).toContain("forbidden");
  });
});
