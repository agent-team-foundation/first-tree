// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileWorkPage } from "../work.js";

const authMock = vi.hoisted(() => ({ value: { agentId: "human-agent-self" } }));
const meChatMocks = vi.hoisted(() => ({
  listMeChats: vi.fn(),
  listMeChatSourceCounts: vi.fn(),
}));

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../api/me-chats.js", () => meChatMocks);
// The drawer's own mobile presentation + attachment fetch is covered by
// components/__tests__/doc-preview-drawer.test.tsx. Here we only assert that
// the mobile chat page mounts it, so a captured `attachment:` link on /m/chat
// has a surface to open instead of silently changing the URL.
vi.mock("../../../components/doc-preview-drawer.js", () => ({
  DocPreviewDrawer: () => <div data-testid="mobile-doc-drawer" />,
}));

describe("MobileWorkPage document-evidence surface", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({
      priorityRows: { attention: [], pinned: [] },
      rows: [],
      nextCursor: null,
    });
    meChatMocks.listMeChatSourceCounts.mockResolvedValue({ counts: {} });
  });

  it("mounts the document preview drawer so captured doc links are not a no-op", async () => {
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

    await harness.waitFor(() =>
      expect(harness.container.querySelector('[data-testid="mobile-doc-drawer"]')).not.toBeNull(),
    );
    await harness.waitFor(() => expect(harness.container.textContent).toContain("No active work"));
  });
});
