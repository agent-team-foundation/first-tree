// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSection } from "../../agent-detail/model-section.js";
import {
  buildInstallCommand,
  PROVIDER_LABEL,
  providerInstallHint,
  runtimeProviderLabel,
} from "../cards/shared/providers.js";
import { providerSupportsInProductAuth } from "../cards/shared/runtime-auth-view.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("Kimi Code provider surfaces", () => {
  it("labels Kimi, keeps in-product device OAuth disabled, and documents official CLI recovery", () => {
    expect(PROVIDER_LABEL["kimi-code"]).toBe("Kimi Code");
    expect(runtimeProviderLabel("kimi-code")).toBe("Kimi Code");
    expect(providerSupportsInProductAuth("kimi-code")).toBe(false);
    expect(buildInstallCommand("kimi-code")).toContain("@moonshot-ai/kimi-code");
    expect(buildInstallCommand("kimi-code")).toContain("/login");
    expect(providerInstallHint("kimi-code", "darwin")).toContain("bundled with First Tree");
  });

  it("exposes DEFAULT + Custom with a local-Kimi default hint on the custom entry", async () => {
    const saved: string[] = [];
    const element = await render(
      <ModelSection value="" onChange={(value) => saved.push(value)} provider="kimi-code" />,
    );
    const trigger = element.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger).not.toBeNull();
    expect(element.querySelector('input[aria-label="Model"]')).toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("(unset — inherits local)");
    expect(document.body.textContent).toContain("Custom model id…");

    const custom = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((b) =>
      b.textContent?.includes("Custom model id…"),
    );
    await act(async () => {
      custom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = element.querySelector<HTMLInputElement>('input[aria-label="Model"]');
    expect(input?.placeholder).toContain("local Kimi default");
    if (!input) throw new Error("model input missing");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, " kimi-for-coding ");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: " kimi-for-coding " }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(saved).toEqual(["kimi-for-coding"]);
  });
});
