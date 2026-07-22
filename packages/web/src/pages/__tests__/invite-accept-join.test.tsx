// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Auth context: an *already-authenticated* visitor on the invite page. We spy
// on selectOrganization (the correct switch) and adoptTokens (which must NOT
// be called — the join endpoint returns no tokens, and adopting `undefined`
// would corrupt the stored session and log the user out).
const authMocks = vi.hoisted(() => ({
  selectOrganization: vi.fn(async () => undefined),
  adoptTokens: vi.fn(async () => undefined),
}));

const apiMocks = vi.hoisted(() => ({ post: vi.fn() }));
const anonymousApiMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    selectOrganization: authMocks.selectOrganization,
    adoptTokens: authMocks.adoptTokens,
    teamDisplayName: "Old Team",
  }),
}));

vi.mock("../../api/client.js", () => ({
  api: { post: apiMocks.post },
}));

vi.mock("../../api/anonymous-client.js", () => ({
  anonymousApi: { get: anonymousApiMocks.get },
}));

vi.mock("../../hooks/use-server-channel.js", () => ({
  useAuthProviderAvailabilityState: () => ({
    providers: { google: true, github: true },
    settled: true,
  }),
}));

import { InviteAcceptPage } from "../invite-accept.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function flush(): Promise<void> {
  // Drain the microtask queue a few times so the preview fetch + the chained
  // join → selectOrganization promises all settle.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  anonymousApiMocks.get.mockResolvedValue({ organizationDisplayName: "Invited Org", expiresAt: null });
  apiMocks.post.mockReset();
  anonymousApiMocks.get.mockClear();
  authMocks.selectOrganization.mockClear();
  authMocks.adoptTokens.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("InviteAcceptPage — authenticated join", () => {
  it("selects the joined org and never adopts the (absent) tokens", async () => {
    // The join endpoint returns no tokens by contract.
    apiMocks.post.mockResolvedValue({ organizationId: "org-invited", memberId: "member-x", role: "member" });

    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <MemoryRouter initialEntries={["/invite/tok-123"]}>
          <Routes>
            <Route path="/invite/:token" element={<InviteAcceptPage />} />
            <Route path="/" element={<div>workspace</div>} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await flush();

    const joinButton = Array.from(container?.querySelectorAll("button") ?? []).find((b) =>
      b.textContent?.includes("Join Invited Org"),
    );
    expect(joinButton, "join button should render for an authenticated visitor").toBeTruthy();

    await act(async () => {
      joinButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Posted to the join endpoint with the URL token.
    expect(apiMocks.post).toHaveBeenCalledWith("/me/organizations/join", { token: "tok-123" });
    // Switched to the just-joined org.
    expect(authMocks.selectOrganization).toHaveBeenCalledWith("org-invited");
    // Crucially: never adopted tokens (the endpoint returns none — adopting
    // `undefined` is what corrupted the session / logged the user out).
    expect(authMocks.adoptTokens).not.toHaveBeenCalled();
  });
});
