// @vitest-environment happy-dom

import type { CapabilityEntry } from "@first-tree/shared";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSection } from "../../agent-detail/model-section.js";
import {
  buildInstallCommand,
  CURSOR_INSTALL_COMMAND,
  PROVIDER_LABEL,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { installBoxView } from "../cards/shared/runtime-install-box.js";

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
  if (!container) throw new Error("container missing");
  return container;
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("cursor provider — setup card surfaces", () => {
  it("labels the provider Cursor", () => {
    expect(PROVIDER_LABEL.cursor).toBe("Cursor");
    expect(runtimeProviderLabel("cursor")).toBe("Cursor");
  });

  it("install command is the official installer script + login, never npm", () => {
    const command = buildInstallCommand("cursor", "darwin");
    expect(command).toBe(`${CURSOR_INSTALL_COMMAND}\ncursor-agent login`);
    expect(command).not.toContain("npm install");
  });

  it("install hint names the official installer for a missing cursor", () => {
    const hint = providerInstallHint("cursor", "darwin");
    expect(hint).toContain(CURSOR_INSTALL_COMMAND);
    expect(hint).toContain("Mac");
  });

  it("probe-error install box falls back to the official installer, not an npm spec", () => {
    const entry: CapabilityEntry = {
      state: "error",
      available: false,
      error: "detection threw",
      detectedAt: "2026-07-14T00:00:00.000Z",
    };
    const view = installBoxView(entry, "cursor", "devbox");
    expect(view.command).toBe(CURSOR_INSTALL_COMMAND);
    expect(view.headline).toContain("Cursor probe failed");
  });
});

describe("cursor provider — DEFAULT + Custom model picker", () => {
  it("exposes unset + custom entry and commits an exact id via Custom", async () => {
    const saved: string[] = [];
    const el = await render(<ModelSection value="" onChange={(v) => saved.push(v)} provider="cursor" />);

    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger).not.toBeNull();
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("(unset — inherits local)");
    expect(body).toContain("Custom model id…");

    const custom = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((b) =>
      b.textContent?.includes("Custom model id…"),
    );
    await act(async () => {
      custom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(saved).toEqual([]);

    const input = el.querySelector<HTMLInputElement>('input[aria-label="Model"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("unreachable");
    expect(input.placeholder).toContain("auto");

    await act(async () => {
      // React tracks the value setter — go through the native prototype setter
      // so the synthetic onChange fires for a controlled input.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, " gpt-5.3-codex-high ");
      input.dispatchEvent(
        new InputEvent("input", { bubbles: true, data: " gpt-5.3-codex-high ", inputType: "insertText" }),
      );
    });
    // No save yet — the field commits on Enter/blur, not per keystroke.
    expect(saved).toEqual([]);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    // Trimmed exact id, committed once; custom mode then returns to the Select.
    expect(saved).toEqual(["gpt-5.3-codex-high"]);
    expect(el.querySelector('button[aria-label="Model"]')).not.toBeNull();
  });

  it("keeps the dropdown for claude/codex providers (no free-form regression)", async () => {
    const el = await render(<ModelSection value="opus" onChange={() => {}} provider="claude-code" />);
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
  });
});
