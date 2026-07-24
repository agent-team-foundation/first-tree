// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileWorkPage } from "../work.js";

const authMock = vi.hoisted(() => ({ value: { agentId: "human-agent-self", organizationId: "org-1" } }));
const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
  listMeChatSourceCounts: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../api/me-chats.js", () => meChatMocks);

describe("mobile projections share the realtime invalidation prefix", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      rows: [],
      priorityRows: { attention: [], pinned: [] },
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
  });

  it("refetches Work when ['me','chats'] is invalidated (answer / new message / failure)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    harness.render(
      <MemoryRouter initialEntries={["/m/work"]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/m/work" element={<MobileWorkPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Let the first fetch settle (empty state renders) before invalidating,
    // so the invalidation queues a real refetch rather than coalescing with an
    // in-flight fetch.
    await harness.waitFor(() => expect(harness.container.textContent).toContain("No active work"));
    expect(meChatMocks.listMeChats).toHaveBeenCalledTimes(1);
    expect(meChatMocks.listMeChatSourceCounts).toHaveBeenCalledTimes(1);

    // A realtime WS event (useAdminWs) or a chat send / ask-answer / new-chat
    // mutation invalidates the shared ["me", "chats"] prefix. The mobile Work
    // projection is nested under that prefix, so it must refetch immediately
    // instead of waiting for the 30s poll.
    await queryClient.invalidateQueries({ queryKey: ["me", "chats"] });

    await harness.waitFor(() => expect(meChatMocks.listMeChats).toHaveBeenCalledTimes(2));
    await harness.waitFor(() => expect(meChatMocks.listMeChatSourceCounts).toHaveBeenCalledTimes(2));
  });
});
