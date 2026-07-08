import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/connection.js";
import { insertMappingIfAbsent, refreshGithubChatTopic } from "../services/github-entity-chat.js";

describe("github entity chat service edge cases", () => {
  it("throws when a conflict winner vanishes before the re-read", async () => {
    const limit = vi.fn(async () => []);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
    } as unknown as Database;

    await expect(
      insertMappingIfAbsent(db, {
        organizationId: "org-1",
        humanAgentId: "human-1",
        delegateAgentId: "agent-1",
        entity: {
          type: "pull_request",
          key: "Acme/Repo#42",
          url: "https://github.com/Acme/Repo/pull/42",
          title: "Race",
        },
        chatId: "chat-1",
        boundVia: "direct",
      }),
    ).rejects.toThrow("mapping insert conflicted but row not visible");
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("swallows topic refresh failures after normalizing the incoming entity", async () => {
    const db = {
      select: vi.fn(() => {
        throw new Error("select failed");
      }),
    } as unknown as Database;

    await expect(
      refreshGithubChatTopic(db, "chat-1", {
        type: "pull_request",
        key: "acme/repo#42",
        url: "https://github.com/acme/repo/pull/42",
        title: "Updated title",
      }),
    ).resolves.toBeUndefined();
  });
});
