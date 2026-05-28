import { describe, expect, it } from "vitest";
import { adapterAttrs, agentAttrs, chatAttrs, inboxAttrs, messageAttrs } from "../span-attrs.js";

describe("span-attrs helpers", () => {
  describe("messageAttrs", () => {
    it("includes all provided fields with standard attribute names", () => {
      const out = messageAttrs({ id: "m1", chatId: "c1", source: "kael", senderAgentId: "a1" });
      expect(out).toEqual({
        "message.id": "m1",
        "chat.id": "c1",
        "message.source": "kael",
        "agent.id": "a1",
      });
    });

    it("omits unset fields rather than emitting undefined", () => {
      const out = messageAttrs({ id: "m1" });
      expect(out).toEqual({ "message.id": "m1" });
      expect("chat.id" in out).toBe(false);
      expect("message.source" in out).toBe(false);
    });

    it("returns an empty object when nothing is provided", () => {
      expect(messageAttrs({})).toEqual({});
    });
  });

  describe("inboxAttrs", () => {
    it("stringifies numeric entry ids (OTel prefers string for ids)", () => {
      const out = inboxAttrs({ id: 42, messageId: "m1", agentId: "a1", status: "pending", retryCount: 2 });
      expect(out).toEqual({
        "inbox.entry.id": "42",
        "message.id": "m1",
        "agent.id": "a1",
        "inbox.entry.status": "pending",
        "inbox.delivery.attempt": 2,
      });
    });

    it("handles retryCount=0 (not falsy-skipped)", () => {
      const out = inboxAttrs({ id: 1, retryCount: 0 });
      expect(out["inbox.delivery.attempt"]).toBe(0);
    });

    it("omits id when undefined or null", () => {
      expect(inboxAttrs({})).toEqual({});
      expect(inboxAttrs({ id: undefined })).toEqual({});
    });
  });

  describe("chatAttrs", () => {
    it("maps fields to namespaced attribute names", () => {
      const out = chatAttrs({ id: "c1", type: "direct", organizationId: "org1" });
      expect(out).toEqual({
        "chat.id": "c1",
        "chat.type": "direct",
        "organization.id": "org1",
      });
    });
  });

  describe("agentAttrs", () => {
    it("accepts either `uuid` or `id`, preferring uuid", () => {
      expect(agentAttrs({ uuid: "u1", id: "fallback" })["agent.id"]).toBe("u1");
      expect(agentAttrs({ id: "i1" })["agent.id"]).toBe("i1");
    });

    it("includes organization and client fields when present", () => {
      const out = agentAttrs({ uuid: "u1", organizationId: "o1", clientId: "cli1" });
      expect(out).toEqual({
        "agent.id": "u1",
        "organization.id": "o1",
        "client.id": "cli1",
      });
    });
  });

  describe("adapterAttrs", () => {
    it("stringifies numeric adapter ids", () => {
      const out = adapterAttrs({ id: 7, platform: "kael", externalChatId: "oc_abc", agentId: "a1" });
      expect(out).toEqual({
        "adapter.id": "7",
        "adapter.platform": "kael",
        "adapter.external_chat_id": "oc_abc",
        "agent.id": "a1",
      });
    });

    it("accepts string ids unchanged", () => {
      expect(adapterAttrs({ id: "github-adapter" })["adapter.id"]).toBe("github-adapter");
    });
  });

  describe("stability of attribute keys (contract)", () => {
    // These assertions guard the *string* keys that become queries in Logfire /
    // Honeycomb. Changing them is a cross-span search-breaking event — the
    // test is effectively a schema contract.
    it("uses lowercase dot-separated keys under documented namespaces", () => {
      const all = {
        ...messageAttrs({ id: "x", chatId: "x", source: "x", senderAgentId: "x" }),
        ...inboxAttrs({ id: 1, messageId: "x", agentId: "x", status: "x", retryCount: 1 }),
        ...chatAttrs({ id: "x", type: "x", organizationId: "x" }),
        ...agentAttrs({ uuid: "x", organizationId: "x", clientId: "x" }),
        ...adapterAttrs({ id: 1, platform: "x", externalChatId: "x", agentId: "x" }),
      };
      const expectedKeys = [
        "message.id",
        "chat.id",
        "message.source",
        "agent.id",
        "inbox.entry.id",
        "inbox.entry.status",
        "inbox.delivery.attempt",
        "chat.type",
        "organization.id",
        "client.id",
        "adapter.id",
        "adapter.platform",
        "adapter.external_chat_id",
      ];
      for (const key of expectedKeys) {
        expect(all).toHaveProperty(key);
      }
    });
  });
});
