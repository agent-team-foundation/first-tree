// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAdminWs } from "../use-admin-ws.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("useAdminWs authority integration boundary", () => {
  it.each([
    true,
    false,
  ])("stays transport-inactive until AuthContext supplies an exact runtime admission (enabled=%s)", async (enabled) => {
    const webSocket = vi.fn(() => {
      throw new Error("the legacy origin-global websocket must not be constructed");
    });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: webSocket });
    Object.defineProperty(window, "WebSocket", { configurable: true, value: webSocket });
    const onMessage = vi.fn();

    function Probe(): null {
      useAdminWs({ enabled, onMessage });
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Probe />));

    expect(webSocket).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
