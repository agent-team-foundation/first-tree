// @vitest-environment happy-dom

import type { ProviderModelCatalog } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCatalogModelOptions, CUSTOM_MODEL_OPTION_VALUE, ModelSection } from "../model-section.js";

const providerModelsMocks = vi.hoisted(() => ({
  getProviderModels: vi.fn(),
}));
vi.mock("../../../api/provider-models.js", () => providerModelsMocks);

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
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

/** Flush microtask/macrotask queues inside act until `predicate` holds (or give up). */
async function flushUntil(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

function renderWithQuery(element: React.ReactElement): Promise<HTMLElement> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

const CURSOR_CATALOG: ProviderModelCatalog = {
  provider: "cursor",
  models: [
    { id: "gpt-5.3-codex-high", label: "GPT-5.3 Codex High" },
    { id: "composer-1", label: "Composer", hint: "fast", isDefault: true },
  ],
  defaultModelId: "composer-1",
  fetchedAt: "2026-07-17T00:00:00.000Z",
  source: "provider-cli",
};

describe("buildCatalogModelOptions", () => {
  it("lists unset (with local default hint), discovered models, current custom value, and the custom entry", () => {
    const items = buildCatalogModelOptions(CURSOR_CATALOG, "my-account-model");
    expect(items.map((o) => o.value)).toEqual([
      "",
      "gpt-5.3-codex-high",
      "composer-1",
      "my-account-model",
      CUSTOM_MODEL_OPTION_VALUE,
    ]);
    expect(items[0]?.hint).toBe("default: composer-1");
    expect(items[2]?.hint).toBe("fast · default");
    expect(items[3]?.hint).toBe("custom");
  });

  it("does not duplicate a saved value that is in the catalog, and omits the default hint when unknown", () => {
    const items = buildCatalogModelOptions({ models: [{ id: "kimi-code/k3" }], defaultModelId: null }, "kimi-code/k3");
    expect(items.map((o) => o.value)).toEqual(["", "kimi-code/k3", CUSTOM_MODEL_OPTION_VALUE]);
    expect(items[0]?.hint).toBeUndefined();
  });
});

describe("ModelSection — daemon catalog", () => {
  it("renders the discovered catalog in the select, marking the local default", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue(CURSOR_CATALOG);
    const el = await renderWithQuery(
      <ModelSection value="gpt-5.3-codex-high" onChange={() => {}} provider="cursor" clientId="c1" />,
    );

    await flushUntil(
      () => el.querySelector('button[aria-label="Model"]')?.textContent?.includes("GPT-5.3 Codex High") ?? false,
    );
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger?.textContent).toContain("GPT-5.3 Codex High");

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("(unset — inherits local)");
    expect(body).toContain("default: composer-1");
    expect(body).toContain("Composer");
    expect(body).toContain("Custom model id…");
  });

  it("saves a catalog pick verbatim", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue(CURSOR_CATALOG);
    const saved: string[] = [];
    const el = await renderWithQuery(
      <ModelSection value="" onChange={(v) => saved.push(v)} provider="cursor" clientId="c1" />,
    );

    await flushUntil(() => {
      const b = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
      return !!b && !b.disabled;
    });
    await act(async () => {
      el.querySelector('button[aria-label="Model"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((b) =>
      b.textContent?.includes("Composer"),
    );
    await act(async () => {
      option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(saved).toEqual(["composer-1"]);
  });

  it("offers the custom entry as a free-form input that commits an exact id", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue(CURSOR_CATALOG);
    const saved: string[] = [];
    const el = await renderWithQuery(
      <ModelSection value="" onChange={(v) => saved.push(v)} provider="cursor" clientId="c1" />,
    );

    await flushUntil(() => {
      const b = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
      return !!b && !b.disabled;
    });
    await act(async () => {
      el.querySelector('button[aria-label="Model"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const custom = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((b) =>
      b.textContent?.includes("Custom model id…"),
    );
    await act(async () => {
      custom?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Switching to custom entry is a mode switch, not a save.
    expect(saved).toEqual([]);

    const input = el.querySelector<HTMLInputElement>('input[aria-label="Model"]');
    expect(input).not.toBeNull();
    if (!input) throw new Error("unreachable");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "some-other-sku");
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "some-other-sku", inputType: "insertText" }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(saved).toEqual(["some-other-sku"]);
  });

  it("keeps DEFAULT + Custom usable with a note when the catalog request fails", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue(null);
    const el = await renderWithQuery(<ModelSection value="" onChange={() => {}} provider="cursor" clientId="c1" />);

    await flushUntil(
      () =>
        el.querySelector('[role="img"]')?.getAttribute("aria-label")?.includes("Couldn't read this computer's model list") ??
        false,
    );
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(false);
    // helpText rides the ? icon's aria-label, not inline text (see ConfigRow).
    expect(el.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "Couldn't read this computer's model list",
    );
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("(unset — inherits local)");
    expect(body).toContain("Custom model id…");
  });

  it("keeps DEFAULT + Custom when discovery reports unavailable", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue({
      ...CURSOR_CATALOG,
      models: [],
      defaultModelId: null,
      source: "unavailable",
      error: "cursor-agent not logged in",
    });
    const el = await renderWithQuery(<ModelSection value="" onChange={() => {}} provider="kimi-code" clientId="c1" />);

    await flushUntil(() => el.querySelector('button[aria-label="Model"]') !== null);
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger?.disabled).toBe(false);
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("(unset — inherits local)");
    expect(body).toContain("Custom model id…");
  });

  it("keeps DEFAULT + Custom enabled while the catalog is still loading", async () => {
    let resolveCatalog: ((value: ProviderModelCatalog) => void) | undefined;
    providerModelsMocks.getProviderModels.mockImplementation(
      () =>
        new Promise<ProviderModelCatalog>((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    const el = await renderWithQuery(
      <ModelSection value="" onChange={() => {}} provider="cursor" clientId="c1" />,
    );

    await flushUntil(() => el.querySelector('button[aria-label="Model"]') !== null);
    const trigger = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.disabled).toBe(false);
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const body = document.body.textContent ?? "";
    expect(body).toContain("(unset — inherits local)");
    expect(body).toContain("Custom model id…");
    expect(el.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "Loading this computer's model list",
    );

    await act(async () => {
      resolveCatalog?.(CURSOR_CATALOG);
    });
  });

  it("keeps the curated fallback for claude when no catalog exists yet", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue(null);
    const el = await renderWithQuery(
      <ModelSection value="opus" onChange={() => {}} provider="claude-code" clientId="c1" />,
    );

    await flushUntil(() => el.querySelector('button[aria-label="Model"]') !== null);
    expect(el.querySelector('input[aria-label="Model"]')).toBeNull();
    expect(el.querySelector('button[aria-label="Model"]')?.textContent).toContain("opus");
  });

  it("saves the empty value when DEFAULT (unset — inherits local) is picked", async () => {
    providerModelsMocks.getProviderModels.mockResolvedValue(CURSOR_CATALOG);
    const saved: string[] = [];
    const el = await renderWithQuery(
      <ModelSection value="composer-1" onChange={(v) => saved.push(v)} provider="cursor" clientId="c1" />,
    );

    await flushUntil(() => {
      const b = el.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
      return !!b && !b.disabled;
    });
    await act(async () => {
      el.querySelector('button[aria-label="Model"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const unset = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((b) =>
      b.textContent?.includes("(unset — inherits local)"),
    );
    await act(async () => {
      unset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Empty string = no override → the host provider's local default applies.
    expect(saved).toEqual([""]);
  });
});
