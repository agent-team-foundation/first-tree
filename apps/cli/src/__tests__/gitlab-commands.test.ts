import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode: number) => {
    throw new Error(`${code}:${message}:${exitCode}`);
  }),
  success: vi.fn(),
}));

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  }),
}));

vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);

function command(parent: Command, name: string): Command {
  const found = parent.commands.find((entry) => entry.name() === name);
  if (!found) throw new Error(`Missing command ${name}`);
  return found;
}

const originalChatId = process.env.FIRST_TREE_CHAT_ID;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.FIRST_TREE_CHAT_ID;
});

afterEach(() => {
  if (originalChatId === undefined) delete process.env.FIRST_TREE_CHAT_ID;
  else process.env.FIRST_TREE_CHAT_ID = originalChatId;
});

describe("gitlab entity attention commands", () => {
  it("registers only follow, following, and unfollow without GitHub-only flags", async () => {
    const { registerGitlabCommands } = await import("../commands/gitlab/index.js");
    const root = new Command();
    registerGitlabCommands(root);

    const gitlab = command(root, "gitlab");
    expect(gitlab.commands.map((entry) => entry.name()).sort()).toEqual(["follow", "following", "unfollow"]);
    expect(command(gitlab, "follow").options.map((option) => option.long)).toEqual(["--chat", "--agent"]);
    expect(gitlab.commands.some((entry) => entry.name() === "context-review")).toBe(false);
  });

  it("follows pending entities, lists projections, and treats zero-removal as terminal success", async () => {
    const entity = {
      entityType: "issue",
      entityUrl: "https://gitlab.example/acme/api/-/issues/42",
      projectPath: "acme/api",
      entityIid: 42,
      title: null,
      state: null,
      status: "pending",
      boundVia: "agent_declared",
    };
    const sdk = {
      followGitlabEntity: vi
        .fn()
        .mockResolvedValueOnce({ status: "created", entity })
        .mockResolvedValueOnce({ status: "already_following", entity }),
      listChatGitlabEntities: vi.fn().mockResolvedValue({ items: [entity] }),
      unfollowGitlabEntity: vi.fn().mockResolvedValueOnce({ removed: 1 }).mockResolvedValueOnce({ removed: 0 }),
    };
    localAgentMocks.createSdk.mockReturnValue(sdk);
    process.env.FIRST_TREE_CHAT_ID = "chat-env";

    const { registerGitlabFollowCommand } = await import("../commands/gitlab/follow.js");
    const followRoot = new Command();
    registerGitlabFollowCommand(followRoot);
    await command(followRoot, "follow").parseAsync([entity.entityUrl, "--agent", "builder"], { from: "user" });
    expect(sdk.followGitlabEntity).toHaveBeenCalledWith("chat-env", { entityUrl: entity.entityUrl });
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("builder");
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("remains pending");
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("has not called GitLab");

    await command(followRoot, "follow").parseAsync([entity.entityUrl, "--chat", "chat-explicit"], {
      from: "user",
    });
    expect(sdk.followGitlabEntity).toHaveBeenLastCalledWith("chat-explicit", { entityUrl: entity.entityUrl });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("Already pending");

    const { registerGitlabFollowingCommand } = await import("../commands/gitlab/following.js");
    const followingRoot = new Command();
    registerGitlabFollowingCommand(followingRoot);
    await command(followingRoot, "following").parseAsync(["--chat", "chat-explicit"], { from: "user" });
    expect(sdk.listChatGitlabEntities).toHaveBeenCalledWith("chat-explicit");

    const { registerGitlabUnfollowCommand } = await import("../commands/gitlab/unfollow.js");
    const unfollowRoot = new Command();
    registerGitlabUnfollowCommand(unfollowRoot);
    await command(unfollowRoot, "unfollow").parseAsync([entity.entityUrl, "--chat", "chat-explicit"], {
      from: "user",
    });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("may create a new route");
    await command(unfollowRoot, "unfollow").parseAsync([entity.entityUrl, "--chat", "chat-explicit"], {
      from: "user",
    });
    expect(String(outputMocks.success.mock.calls.at(-1)?.[0].hint)).toContain("terminal success");
  });

  it("maps GitLab-specific deterministic failures and generic SDK errors", async () => {
    const { handleGitlabSdkError } = await import("../commands/gitlab/_shared.js");

    expect(() => handleGitlabSdkError(new SdkError(400, "origin mismatch"))).toThrow("INVALID_GITLAB_ENTITY_URL");
    expect(() => handleGitlabSdkError(new SdkError(404, "GitLab connection is not configured"))).toThrow(
      "NO_GITLAB_CONNECTION",
    );
    const generic = new Error("server unavailable");
    expect(() => handleGitlabSdkError(generic)).toThrow("server unavailable");
    expect(localAgentMocks.handleSdkError).toHaveBeenLastCalledWith(generic);
  });

  it("requires a chat context before creating an SDK", async () => {
    const { registerGitlabFollowingCommand } = await import("../commands/gitlab/following.js");
    const root = new Command();
    registerGitlabFollowingCommand(root);

    await expect(command(root, "following").parseAsync([], { from: "user" })).rejects.toThrow("NO_CHAT_CONTEXT");
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });
});
