import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, SdkError } from "../sdk.js";

describe("FirstTreeHubSDK messaging methods", () => {
  let sdk: FirstTreeHubSDK;
  const mockFetch = vi.fn<typeof globalThis.fetch>();

  beforeEach(() => {
    sdk = new FirstTreeHubSDK({ serverUrl: "http://localhost:8000", token: "aghub_test" });
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockJsonResponse(data: unknown, status = 200) {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(data), { status }));
  }

  function mockErrorResponse(error: string, status: number) {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status }));
  }

  describe("listChats", () => {
    it("fetches chats with default params", async () => {
      const payload = { items: [{ id: "chat-1", type: "direct" }], nextCursor: null };
      mockJsonResponse(payload);

      const result = await sdk.listChats();
      expect(result).toEqual(payload);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:8000/api/v1/agent/chats");
    });

    it("passes limit and cursor as query params", async () => {
      mockJsonResponse({ items: [], nextCursor: null });

      await sdk.listChats({ limit: 5, cursor: "2026-01-01T00:00:00Z" });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("limit=5");
      expect(url).toContain("cursor=2026-01-01T00%3A00%3A00Z");
    });

    it("throws SdkError on auth failure", async () => {
      mockErrorResponse("Unauthorized", 401);

      try {
        await sdk.listChats();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SdkError);
        expect((err as SdkError).statusCode).toBe(401);
      }
    });
  });

  describe("listMessages", () => {
    it("fetches messages for a chat", async () => {
      const payload = {
        items: [{ id: "msg-1", senderId: "a1", format: "text", content: "hello" }],
        nextCursor: null,
      };
      mockJsonResponse(payload);

      const result = await sdk.listMessages("chat-abc");
      expect(result).toEqual(payload);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:8000/api/v1/agent/chats/chat-abc/messages");
    });

    it("passes limit and cursor as query params", async () => {
      mockJsonResponse({ items: [], nextCursor: null });

      await sdk.listMessages("chat-abc", { limit: 10, cursor: "2026-03-25T00:00:00Z" });

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain("chat-abc/messages?");
      expect(url).toContain("limit=10");
      expect(url).toContain("cursor=");
    });

    it("throws SdkError on 403 (not participant)", async () => {
      mockErrorResponse("Not a participant of this chat", 403);

      try {
        await sdk.listMessages("chat-private");
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SdkError);
        expect((err as SdkError).statusCode).toBe(403);
      }
    });
  });

  describe("sendToAgent", () => {
    it("sends a direct message to another agent", async () => {
      const msg = { id: "msg-1", chatId: "chat-1", senderId: "sender", format: "text", content: "hi" };
      mockJsonResponse(msg, 201);

      const result = await sdk.sendToAgent("target-agent", { format: "text", content: "hi" });
      expect(result).toEqual(msg);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:8000/api/v1/agent/agents/target-agent/messages");
      expect(init.method).toBe("POST");
    });
  });

  describe("sendMessage", () => {
    it("sends a message to a chat", async () => {
      const msg = { id: "msg-1", chatId: "chat-1", senderId: "sender", format: "markdown", content: "# Hi" };
      mockJsonResponse(msg, 201);

      const result = await sdk.sendMessage("chat-1", { format: "markdown", content: "# Hi" });
      expect(result).toEqual(msg);

      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://localhost:8000/api/v1/agent/chats/chat-1/messages");
      expect(init.method).toBe("POST");
    });
  });
});
