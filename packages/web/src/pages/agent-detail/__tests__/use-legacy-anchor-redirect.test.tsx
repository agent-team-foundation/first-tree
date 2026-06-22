// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useLegacyAnchorRedirect } from "../use-legacy-anchor-redirect.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function Harness() {
  useLegacyAnchorRedirect();
  const loc = useLocation();
  return <span data-testid="loc">{loc.pathname}</span>;
}

async function renderAt(entry: string): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/agents/:uuid/*" element={<Harness />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("useLegacyAnchorRedirect", () => {
  it("redirects the legacy repos anchor to the new Repositories tab", async () => {
    const container = await renderAt("/agents/agent-1/profile#agent-cfg-git");
    expect(container.querySelector('[data-testid="loc"]')?.textContent).toBe("/agents/agent-1/repositories");
  });

  it("keeps env/model anchors on the Runtime tab", async () => {
    const env = await renderAt("/agents/agent-1/profile#agent-cfg-env");
    expect(env.querySelector('[data-testid="loc"]')?.textContent).toBe("/agents/agent-1/runtime");
    await act(async () => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    const model = await renderAt("/agents/agent-1/profile#agent-cfg-model");
    expect(model.querySelector('[data-testid="loc"]')?.textContent).toBe("/agents/agent-1/runtime");
  });

  it("leaves the path untouched when there is no legacy hash", async () => {
    const container = await renderAt("/agents/agent-1/profile");
    expect(container.querySelector('[data-testid="loc"]')?.textContent).toBe("/agents/agent-1/profile");
  });
});
