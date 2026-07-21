import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateDisplayNameQueries } from "../identity-cache.js";

describe("invalidateDisplayNameQueries", () => {
  it("invalidates every cached projection that carries a mutable display name", async () => {
    const queryClient = new QueryClient();
    const identityKeys = [
      ["members"],
      ["agents"],
      ["managed-agents", "member-1"],
      ["agent", "agent-1"],
      ["agents-for-delegate", "member-1"],
      ["context-build", "managed-agents", "org-1"],
      ["context-reviewer", "org-agents", "org-1"],
      ["participant-name-cache"],
      ["mobile", "team", "members"],
      ["mobile", "team", "agents", "admin"],
      ["me", "chats"],
      ["chat-detail", "chat-1"],
    ] as const;
    const unrelatedKey = ["repositories", "agent-1"] as const;

    for (const key of [...identityKeys, unrelatedKey]) {
      queryClient.setQueryData(key, { label: "Old name" });
    }

    await invalidateDisplayNameQueries(queryClient);

    for (const key of identityKeys) {
      expect(queryClient.getQueryState(key)?.isInvalidated, key.join("/")).toBe(true);
    }
    expect(queryClient.getQueryState(unrelatedKey)?.isInvalidated).toBe(false);
  });
});
