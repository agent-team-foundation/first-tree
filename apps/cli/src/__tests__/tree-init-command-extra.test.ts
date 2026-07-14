import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../commands/types.js";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const treeSharedMocks = vi.hoisted(() => ({
  runCommand: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: bootstrapMocks.ensureFreshAccessToken,
  resolveServerUrl: bootstrapMocks.resolveServerUrl,
}));

vi.mock("../commands/tree/shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/tree/shared.js")>();
  return {
    ...actual,
    runCommand: treeSharedMocks.runCommand,
  };
});

const originalCwd = process.cwd();
const tempDirs: string[] = [];
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ft-tree-init-action-"));
  tempDirs.push(dir);
  return dir;
}

function context(command: Command, json = false): CommandContext {
  return { command, options: { debug: false, json, quiet: false } };
}

function commandWithOptions(options: Record<string, unknown>): Command {
  const command = new Command("init");
  for (const [key, value] of Object.entries(options)) {
    command.setOptionValue(key, value);
  }
  return command;
}

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function mockGithubApi(): void {
  treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
    if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) {
      return "";
    }
    if (tool === "gh" && args[0] === "api" && args[1] === "user") {
      return "octocat";
    }
    if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
      return JSON.stringify({ html_url: `https://github.com/${args[1].slice("repos/".length)}` });
    }
    return "";
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://server.example");
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  mockGithubApi();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.chdir(originalCwd);
  process.exitCode = undefined;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("tree init command action", () => {
  it("creates and summarizes an unbound Context Tree with local gh/git only", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const command = commandWithOptions({
      bind: false,
      dir: "local-tree",
      name: "custom-tree",
      public: true,
      title: "Acme Product",
      withWorkflow: true,
    });

    await initCommand.action(context(command, true));

    const root = join(base, "local-tree");
    const commandRoot = realpathSync(root);
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(root, "NODE.md"))).toBe(true);
    expect(existsSync(join(root, "members", "octocat", "NODE.md"))).toBe(true);
    expect(existsSync(join(root, ".github", "workflows", "validate-tree.yml"))).toBe(true);
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain("Acme Product Context Tree");
    expect(treeSharedMocks.runCommand).toHaveBeenCalledWith(
      "gh",
      ["repo", "create", "octocat/custom-tree", "--public", "--source", commandRoot, "--remote", "origin", "--push"],
      commandRoot,
    );

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      bound: false,
      branch: "main",
      htmlUrl: "https://github.com/octocat/custom-tree",
      owner: "octocat",
      withWorkflow: true,
    });
    expect(summary.coverage).toBeNull();
  });

  it("binds under the GitHub App installation account and reports coverage guidance", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({
          defaultOrganizationId: "org_1",
          memberships: [{ organizationId: "org_1", role: "admin" }],
        });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response({ repo: null });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response({
          accountLogin: "acme-org",
          accountType: "Organization",
          installationId: 123,
          suspended: false,
        });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
        expect(init.body).toBe(JSON.stringify({ repo: "https://github.com/acme-org/acme-context-tree" }));
        return response("ok");
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const command = commandWithOptions({
      bind: true,
      public: false,
      title: "Acme",
      withWorkflow: false,
    });

    await initCommand.action(context(command, true));

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(process.exitCode).toBeUndefined();
    expect(summary).toMatchObject({
      bound: true,
      htmlUrl: "https://github.com/acme-org/acme-context-tree",
      name: "acme-context-tree",
      owner: "acme-org",
    });
    expect(summary.coverage).toMatchObject({
      appSettingsUrl: "https://github.com/organizations/acme-org/settings/installations/123",
      status: "guided",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server.example/api/v1/orgs/org_1/settings/context_tree",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("falls back to the legacy settings read when the server lacks the raw endpoint", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/me")) {
        return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
        return response("not found", { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method !== "PUT") {
        return response({ repo: null });
      }
      if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
        return response("missing", { status: 404 });
      }
      if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
        return response("ok");
      }
      return response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Legacy Server" }), true));

    expect(process.exitCode).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server.example/api/v1/orgs/org_1/settings/context_tree/raw",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://server.example/api/v1/orgs/org_1/settings/context_tree",
      expect.any(Object),
    );
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({ bound: true, owner: "octocat" });
  });

  it("continues binding with no installation and warns that snapshots are not covered yet", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ repo: null });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response("missing", { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
          return response("ok");
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Solo" }), true));

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary).toMatchObject({
      bound: true,
      htmlUrl: "https://github.com/octocat/solo-context-tree",
      owner: "octocat",
    });
    expect(summary.coverage).toMatchObject({ appSettingsUrl: null, status: "no_installation" });
  });

  it("prints the human summary for a single-org bind with no GitHub App installation", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ repo: null });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response("missing", { status: 404 });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
          return response("ok");
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, title: "Solo Human" }), false));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(process.exitCode).toBeUndefined();
    expect(output).toContain("Context Tree Init");
    expect(output).toContain("Repository:   octocat/solo-human-context-tree");
    expect(output).toContain("GitHub App coverage:");
    expect(output).toContain("No GitHub App installation is connected");
    expect(output).toContain("Context Tree created and bound.");
  });

  it("prints the human summary for an unbound tree using default title and repo name", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);

    await initCommand.action(context(commandWithOptions({ bind: false, withWorkflow: false }), false));

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join("\n");
    expect(process.exitCode).toBeUndefined();
    expect(output).toContain("Repository:   octocat/octocat-context-tree");
    expect(output).toContain("Validate CI:  not seeded");
    expect(output).toContain("Bound to org: no (--no-bind)");
    expect(output).toContain("Context Tree created.");
  });

  it("fails before remote writes when binding preconditions are not satisfied", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const cases: Array<{
      name: string;
      command: Command;
      fetch: (input: FetchInput, init?: FetchInit) => Promise<Response>;
      message: string;
    }> = [
      {
        name: "non-admin",
        command: commandWithOptions({ bind: true, org: "org_1", title: "No Admin" }),
        fetch: async (input) =>
          String(input).endsWith("/api/v1/me")
            ? response({ memberships: [{ organizationId: "org_1", role: "member" }] })
            : response("not found", { status: 404 }),
        message: "requires admin of org org_1",
      },
      {
        name: "existing binding",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Existing" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: "https://github.com/acme/live-tree" });
          }
          return response("not found", { status: 404 });
        },
        message: "already bound to a Context Tree",
      },
      {
        name: "binding read failure",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Binding Read" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response("server down", { status: 503 });
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's current Context Tree binding",
      },
      {
        name: "invalid repo-less branch",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Invalid Branch" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ branch: "--bad" });
          }
          return response("not found", { status: 404 });
        },
        message: "Context Tree binding contains an invalid branch",
      },
      {
        name: "installation lookup failure",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: null });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response("server down", { status: 500 });
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "installation network failure",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup Network" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: null });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            throw new Error("network down");
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "installation invalid body",
        command: commandWithOptions({ bind: true, org: "org_1", title: "Lookup Invalid" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: null });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response({ installationId: "not-a-number" });
          }
          return response("not found", { status: 404 });
        },
        message: "Could not read the team's GitHub App installation",
      },
      {
        name: "owner mismatch",
        command: commandWithOptions({ bind: true, org: "org_1", owner: "octocat", title: "Mismatch" }),
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/api/v1/me")) {
            return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
          }
          if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
            return response({ repo: null });
          }
          if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
            return response({
              accountLogin: "acme-org",
              accountType: "Organization",
              installationId: 456,
              suspended: false,
            });
          }
          return response("not found", { status: 404 });
        },
        message: "does not match this team's GitHub App installation account",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockGithubApi();
      process.exitCode = undefined;
      const base = makeTempDir();
      process.chdir(base);
      vi.stubGlobal("fetch", vi.fn(testCase.fetch));

      await initCommand.action(context(testCase.command, false));

      expect(process.exitCode, testCase.name).toBe(1);
      expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).toContain(testCase.message);
      expect(
        treeSharedMocks.runCommand.mock.calls.some(
          ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
        ),
        testCase.name,
      ).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("fails early for missing tools, unauthenticated gh, missing login, and non-empty targets", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const cases: Array<{
      name: string;
      command?: Command;
      runCommand: (tool: string, args: string[]) => string;
      message: string;
      setup?: (base: string) => void;
    }> = [
      {
        name: "missing git",
        runCommand: (tool, args) => {
          if (tool === "git" && args[0] === "--version") throw new Error("missing git");
          return "";
        },
        message: "`git` is required",
      },
      {
        name: "gh auth",
        runCommand: (tool, args) => {
          if (args[0] === "--version") return "";
          if (tool === "gh" && args[0] === "auth") throw new Error("not logged in");
          return "";
        },
        message: "GitHub CLI is not authenticated",
      },
      {
        name: "missing login",
        runCommand: (tool, args) => {
          if (args[0] === "--version" || (tool === "gh" && args[0] === "auth")) return "";
          if (tool === "gh" && args[0] === "api" && args[1] === "user") return "";
          return "";
        },
        message: "Could not resolve your GitHub login",
      },
      {
        name: "non-empty dir",
        command: commandWithOptions({ bind: false, dir: "already-here", title: "Busy" }),
        setup: (base) => {
          const dir = join(base, "already-here");
          rmSync(dir, { recursive: true, force: true });
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "README.md"), "busy\n");
        },
        runCommand: (tool, args) => {
          if (args[0] === "--version" || (tool === "gh" && args[0] === "auth")) return "";
          if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
          return "";
        },
        message: "Target directory is not empty",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      process.exitCode = undefined;
      const base = makeTempDir();
      process.chdir(base);
      testCase.setup?.(base);
      treeSharedMocks.runCommand.mockImplementation(testCase.runCommand);

      await initCommand.action(
        context(testCase.command ?? commandWithOptions({ bind: false, title: "Broken" }), false),
      );

      expect(process.exitCode, testCase.name).toBe(1);
      expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).toContain(testCase.message);
    }
  });

  it("fails org resolution before GitHub writes when /me is unusable or ambiguous", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const cases: Array<{ name: string; me: unknown; status?: number; message: string }> = [
      { name: "me 500", me: "down", status: 500, message: "server returned 500 on /me" },
      { name: "missing memberships", me: {}, message: "don't belong to any organization" },
      { name: "no orgs", me: { memberships: [] }, message: "don't belong to any organization" },
      {
        name: "multiple orgs",
        me: { memberships: [{ organizationId: "org_1" }, { organizationId: "org_2" }] },
        message: "Multiple organizations",
      },
    ];

    for (const testCase of cases) {
      vi.clearAllMocks();
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockGithubApi();
      process.exitCode = undefined;
      const base = makeTempDir();
      process.chdir(base);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: FetchInput) =>
          String(input).endsWith("/api/v1/me")
            ? response(testCase.me, { status: testCase.status ?? 200 })
            : response("not found", { status: 404 }),
        ),
      );

      await initCommand.action(context(commandWithOptions({ bind: true, title: testCase.name }), false));

      expect(process.exitCode, testCase.name).toBe(1);
      expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0]), testCase.name).toContain(testCase.message);
      expect(
        treeSharedMocks.runCommand.mock.calls.some(
          ([tool, args]) => tool === "gh" && Array.isArray(args) && args[0] === "repo" && args[1] === "create",
        ),
      ).toBe(false);
      vi.unstubAllGlobals();
    }
  });

  it("surfaces repo URL lookup and org binding failures after remote create", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
      if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) return "";
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
      if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
        return "{}";
      }
      return "";
    });

    await initCommand.action(context(commandWithOptions({ bind: false, title: "Missing Repo Url" }), false));
    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("could not read its URL");

    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockGithubApi();
    process.exitCode = undefined;
    process.chdir(makeTempDir());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ repo: null });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) return response("missing", { status: 404 });
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
          return response("server refused binding", { status: 500 });
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Bind Fails" }), false));
    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("binding failed");
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("server refused binding");
  });

  it("surfaces unexpected GitHub API response shapes after remote create", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    treeSharedMocks.runCommand.mockImplementation((tool: string, args: string[]) => {
      if (args[0] === "--version" || (tool === "gh" && args[0] === "auth" && args[1] === "status")) return "";
      if (tool === "gh" && args[0] === "api" && args[1] === "user") return "octocat";
      if (tool === "gh" && args[0] === "api" && typeof args[1] === "string" && args[1].startsWith("repos/")) {
        return "null";
      }
      return "";
    });

    await initCommand.action(context(commandWithOptions({ bind: false, title: "Bad Api" }), false));

    expect(process.exitCode).toBe(1);
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toContain("Unexpected GitHub API response");
  });

  it("surfaces suspended installation guidance in the final summary", async () => {
    const { initCommand } = await import("../commands/tree/init.js");
    const base = makeTempDir();
    process.chdir(base);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: FetchInput, init?: FetchInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me")) {
          return response({ memberships: [{ organizationId: "org_1", role: "admin" }] });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree/raw")) {
          return response({ repo: null });
        }
        if (url.endsWith("/api/v1/orgs/org_1/context-tree/installation")) {
          return response({
            accountLogin: "bestony",
            accountType: "User",
            installationId: 789,
            suspended: true,
          });
        }
        if (url.endsWith("/api/v1/orgs/org_1/settings/context_tree") && init?.method === "PUT") {
          return response("ok");
        }
        return response("not found", { status: 404 });
      }),
    );

    await initCommand.action(context(commandWithOptions({ bind: true, org: "org_1", title: "Personal" }), true));

    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(summary.coverage).toMatchObject({
      appSettingsUrl: "https://github.com/settings/installations/789",
      status: "suspended",
    });
  });
});
