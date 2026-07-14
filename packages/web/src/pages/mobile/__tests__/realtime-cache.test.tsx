// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileNowPage } from "../now.js";

const authMock = vi.hoisted(() => ({ value: { agentId: "human-agent-self" } }));
const meChatMocks = vi.hoisted(() => ({ listMeChats: vi.fn() }));

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
  });

  it("refetches Now when ['me','chats'] is invalidated (answer / new message / failure)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    harness.render(
      <MemoryRouter initialEntries={["/m/now"]}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/m/now" element={<MobileNowPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    // Let the first fetch settle (empty state renders) before invalidating,
    // so the invalidation queues a real refetch rather than coalescing with an
    // in-flight fetch.
    await harness.waitFor(() => expect(harness.container.textContent).toContain("You're all caught up"));
    expect(meChatMocks.listMeChats).toHaveBeenCalledTimes(1);

    // A realtime WS event (useAdminWs) or a chat send / ask-answer / new-chat
    // mutation invalidates the shared ["me", "chats"] prefix. The mobile Now
    // projection is nested under that prefix, so it must refetch immediately
    // instead of waiting for the 30s poll.
    await queryClient.invalidateQueries({ queryKey: ["me", "chats"] });

    await harness.waitFor(() => expect(meChatMocks.listMeChats).toHaveBeenCalledTimes(2));
  });
});
