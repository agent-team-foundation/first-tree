import { AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.fn();

function response(ok: boolean, status: number, body: unknown, rejectJson = false) {
  return {
    ok,
    status,
    json: rejectJson
      ? async () => {
          throw new Error("bad json");
        }
      : async () => body,
  };
}

async function loadCore() {
  vi.doMock("../core/cli-fetch.js", () => ({
    cliFetch: cliFetchMock,
  }));
  return import("../core/feishu.js");
}

describe("Feishu core helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("binds bot credentials with user JWT and acting agent headers", async () => {
    const { bindFeishuBot } = await loadCore();
    cliFetchMock.mockResolvedValue(response(true, 200, {}));

    await bindFeishuBot("https://hub.example.test", "access-token", "agent-1", "app-id", "app-secret");

    expect(cliFetchMock).toHaveBeenCalledWith("https://hub.example.test/api/v1/agent/me/feishu-bot", {
      method: "PUT",
      headers: {
        Authorization: "Bearer access-token",
        [AGENT_SELECTOR_HEADER]: "agent-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ appId: "app-id", appSecret: "app-secret" }),
    });
  });

  it("binds delegated Feishu users and URL-encodes the human agent id", async () => {
    const { bindFeishuUser } = await loadCore();
    cliFetchMock.mockResolvedValue(response(true, 200, {}));

    await bindFeishuUser("https://hub.example.test", "access-token", "agent-1", "human/id", "ou_123", "Ada");

    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example.test/api/v1/agent/delegated/human%2Fid/feishu-user",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer access-token",
          [AGENT_SELECTOR_HEADER]: "agent-1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ feishuUserId: "ou_123", displayName: "Ada" }),
      },
    );
  });

  it("uses server error bodies when present and falls back to HTTP status", async () => {
    const { bindFeishuBot, bindFeishuUser } = await loadCore();

    cliFetchMock.mockResolvedValueOnce(response(false, 403, { error: "not owner" }));
    await expect(
      bindFeishuBot("https://hub.example.test", "access-token", "agent-1", "app-id", "secret"),
    ).rejects.toThrow("not owner");

    cliFetchMock.mockResolvedValueOnce(response(false, 500, {}, true));
    await expect(
      bindFeishuUser("https://hub.example.test", "access-token", "agent-1", "human", "ou_123"),
    ).rejects.toThrow("Bind Feishu user failed: HTTP 500");
  });
});
