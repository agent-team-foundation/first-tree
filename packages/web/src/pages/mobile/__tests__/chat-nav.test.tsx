// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { MemoryRouter, Route, Routes, useNavigationType } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileChatPage } from "../chat.js";

const authMock = vi.hoisted(() => ({ value: { agentId: "human-agent-self" } }));
const meChatMocks = vi.hoisted(() => ({ listMeChats: vi.fn() }));

vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../../api/me-chats.js", () => meChatMocks);
// Stub the heavy chat-detail so we can drive the back affordance directly.
vi.mock("../../workspace/center/index.js", () => ({
  CenterPanel: ({ onShowConversations }: { onShowConversations: (() => void) | null }) => (
    <button type="button" aria-label="back" onClick={() => onShowConversations?.()}>
      back
    </button>
  ),
}));

let lastNavType = "";
function NavProbe() {
  lastNavType = useNavigationType();
  return null;
}

describe("MobileChatPage back navigation", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    meChatMocks.listMeChats.mockReset();
    meChatMocks.listMeChats.mockResolvedValue({ priorityRows: { attention: [], pinned: [] }, rows: [] });
    lastNavType = "";
  });

  it("replaces the detail entry on back so browser Back does not reopen it", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Start on the chat detail (c=chat-1) with the list already behind it.
    harness.render(
      <MemoryRouter initialEntries={["/m/chat", "/m/chat?c=chat-1"]}>
        <QueryClientProvider client={queryClient}>
          <NavProbe />
          <Routes>
            <Route path="/m/chat" element={<MobileChatPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const back = harness.container.querySelector<HTMLButtonElement>('button[aria-label="back"]');
    expect(back).not.toBeNull();
    expect(lastNavType).toBe("POP"); // initial

    await act(async () => {
      back?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await harness.flush();

    // clearChat must REPLACE the detail with the list (not PUSH), so the
    // browser Back button / swipe cannot reopen the chat detail just exited.
    expect(lastNavType).toBe("REPLACE");
  });
});
