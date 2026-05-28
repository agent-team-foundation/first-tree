import type { AgentSkills } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import {
  checkAgentNameAvailability,
  clearAgentAvatarImage,
  fetchUserAvatarForHumanAgent,
  getAgentAvatarImage,
  getAgentSkills,
  MAX_AVATAR_IMAGE_BYTES,
  setAgentAvatarImage,
  updateAgentSkills,
} from "../services/agent.js";

type DbCaptures = {
  updates: unknown[];
};

function createDb(
  options: { selectRows?: unknown[][]; updateRows?: unknown[][]; captures?: DbCaptures } = {},
): Database {
  const selectRows = [...(options.selectRows ?? [])];
  const updateRows = [...(options.updateRows ?? [])];
  const captures = options.captures;
  const selectChain = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    limit: async () => selectRows.shift() ?? [],
    where: () => selectChain,
  };
  const updateChain = {
    returning: async () => updateRows.shift() ?? [],
    set: (value: unknown) => {
      captures?.updates.push(value);
      return updateChain;
    },
    where: () => updateChain,
  };
  return {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as Database;
}

describe("agent service storage branches", () => {
  it("checks name availability for invalid, reserved, taken, and available names", async () => {
    await expect(checkAgentNameAvailability(createDb(), "org-1", "No Spaces")).resolves.toEqual({
      available: false,
      reason: "invalid",
    });
    await expect(checkAgentNameAvailability(createDb(), "org-1", "system")).resolves.toEqual({
      available: false,
      reason: "reserved",
    });
    await expect(
      checkAgentNameAvailability(createDb({ selectRows: [[{ uuid: "agent-1" }]] }), "org-1", "atlas"),
    ).resolves.toEqual({ available: false, reason: "taken" });
    await expect(checkAgentNameAvailability(createDb({ selectRows: [[]] }), "org-1", "new-agent")).resolves.toEqual({
      available: true,
    });
  });

  it("fetches human avatar URLs only for human agents", async () => {
    await expect(fetchUserAvatarForHumanAgent(createDb(), { uuid: "agent-bot", type: "agent" })).resolves.toBeNull();
    await expect(
      fetchUserAvatarForHumanAgent(createDb({ selectRows: [[{ avatarUrl: "https://example.test/avatar.png" }]] }), {
        uuid: "agent-human",
        type: "human",
      }),
    ).resolves.toBe("https://example.test/avatar.png");
    await expect(
      fetchUserAvatarForHumanAgent(createDb({ selectRows: [[]] }), { uuid: "agent-human", type: "human" }),
    ).resolves.toBeNull();
  });

  it("reads, validates, writes, and clears uploaded avatar images", async () => {
    const updatedAt = new Date("2026-05-28T00:00:00.000Z");
    await expect(
      getAgentAvatarImage(
        createDb({ selectRows: [[{ data: Buffer.from("image"), mime: "image/png", updatedAt }]] }),
        "agent-1",
      ),
    ).resolves.toEqual({ data: Buffer.from("image"), mime: "image/png", updatedAt });
    await expect(
      getAgentAvatarImage(createDb({ selectRows: [[{ data: null, mime: null, updatedAt: null }]] }), "agent-1"),
    ).resolves.toBeNull();
    await expect(getAgentAvatarImage(createDb({ selectRows: [[]] }), "agent-1")).resolves.toBeNull();

    await expect(setAgentAvatarImage(createDb(), "agent-1", Buffer.from("x"), "image/gif")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(setAgentAvatarImage(createDb(), "agent-1", Buffer.alloc(0), "image/png")).rejects.toBeInstanceOf(
      BadRequestError,
    );
    await expect(
      setAgentAvatarImage(createDb(), "agent-1", Buffer.alloc(MAX_AVATAR_IMAGE_BYTES + 1), "image/png"),
    ).rejects.toBeInstanceOf(BadRequestError);

    const captures: DbCaptures = { updates: [] };
    const savedAt = await setAgentAvatarImage(
      createDb({ captures, updateRows: [[{ uuid: "agent-1" }]] }),
      "agent-1",
      Buffer.from("ok"),
      "image/webp",
    );
    expect(savedAt).toBeInstanceOf(Date);
    expect(captures.updates[0]).toEqual(
      expect.objectContaining({ avatarImageData: Buffer.from("ok"), avatarImageMime: "image/webp" }),
    );
    await expect(
      setAgentAvatarImage(createDb({ updateRows: [[]] }), "missing", Buffer.from("ok"), "image/png"),
    ).rejects.toBeInstanceOf(NotFoundError);

    await expect(
      clearAgentAvatarImage(createDb({ captures, updateRows: [[{ uuid: "agent-1" }]] }), "agent-1"),
    ).resolves.toBeUndefined();
    expect(captures.updates.at(-1)).toEqual(
      expect.objectContaining({ avatarImageData: null, avatarImageMime: null, avatarImageUpdatedAt: null }),
    );
    await expect(clearAgentAvatarImage(createDb({ updateRows: [[]] }), "missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("reads and replaces agent skill snapshots", async () => {
    const skills: AgentSkills = [{ name: "review", description: "Review code", source: "project" }];
    await expect(getAgentSkills(createDb({ selectRows: [[{ skills }]] }), "agent-1")).resolves.toEqual(skills);
    await expect(getAgentSkills(createDb({ selectRows: [[]] }), "missing")).rejects.toBeInstanceOf(NotFoundError);

    const captures: DbCaptures = { updates: [] };
    await expect(
      updateAgentSkills(createDb({ captures, updateRows: [[{ uuid: "agent-1" }]] }), "agent-1", skills),
    ).resolves.toBeUndefined();
    expect(captures.updates[0]).toEqual(expect.objectContaining({ skills }));
    await expect(updateAgentSkills(createDb({ updateRows: [[]] }), "missing", skills)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
