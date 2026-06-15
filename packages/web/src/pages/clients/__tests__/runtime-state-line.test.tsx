// @vitest-environment happy-dom

import type { CapabilityEntry } from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeStateLine } from "../cards/shared/runtime-state-line.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = null;
  container = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("RuntimeStateLine", () => {
  it("shows when Codex is running through the system CLI fallback", async () => {
    const entry: CapabilityEntry = {
      available: true,
      state: "ok",
      authenticated: true,
      sdkVersion: "0.139.0",
      authMethod: "auth_json",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="codex" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("Codex v0.139.0");
    expect(dom.textContent).toContain("system CLI fallback");
  });

  it("keeps the login recovery hint when the fallback CLI is unauthenticated", async () => {
    const entry: CapabilityEntry = {
      available: true,
      state: "unauthenticated",
      authenticated: false,
      sdkVersion: "0.139.0",
      authMethod: "none",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: "2026-06-12T12:00:00.000Z",
    };

    const dom = await render(<RuntimeStateLine provider="codex" entry={entry} os="darwin" />);

    expect(dom.textContent).toContain("system CLI fallback");
    expect(dom.textContent).toContain("needs login");
    expect(dom.textContent).toContain("codex login");
  });
});
