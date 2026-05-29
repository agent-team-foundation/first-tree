// @vitest-environment happy-dom

import type { Attention } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../ui/toast.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const attentionApiMocks = vi.hoisted(() => ({
  respondAttention: vi.fn(),
}));

vi.mock("../../../api/attention.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/attention.js")>()),
  respondAttention: attentionApiMocks.respondAttention,
}));

vi.mock("../../../lib/use-agent-name-map.js", () => ({
  useAgentNameMap: () => (id: string | null | undefined) => (id === "agent-1" ? "Kael" : (id ?? "unknown")),
}));

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: overrides.id ?? "attention-123456789",
    originAgentId: overrides.originAgentId ?? "agent-1",
    originChatId: overrides.originChatId ?? "chat-1",
    targetHumanId: overrides.targetHumanId ?? "human-agent-self",
    subject: overrides.subject ?? "Choose rollout scope",
    body: overrides.body ?? "The deploy can proceed now or wait for the next maintenance window.",
    requiresResponse: overrides.requiresResponse ?? true,
    state: overrides.state ?? "open",
    response: overrides.response ?? null,
    respondedBy: overrides.respondedBy ?? null,
    respondedAt: overrides.respondedAt ?? null,
    cancelled: overrides.cancelled ?? false,
    cancelledReason: overrides.cancelledReason ?? null,
    metadata:
      overrides.metadata ??
      ({
        options: {
          mode: "single",
          defaultValue: "now",
          items: [
            { value: "now", label: "Ship now", hint: "Proceed with the current release." },
            { value: "later", label: "Wait", hint: "Defer until the next window." },
          ],
        },
      } satisfies Attention["metadata"]),
    createdAt: overrides.createdAt ?? new Date(Date.now() - 60_000).toISOString(),
    closedAt: overrides.closedAt ?? null,
  };
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{element}</ToastProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setValue(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  });
  await flush();
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((entry) => entry.textContent?.includes(text));
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = "";
  attentionApiMocks.respondAttention.mockReset();
  attentionApiMocks.respondAttention.mockImplementation(
    async (id: string, body: { text?: string; answers?: Record<string, unknown> }) => ({
      ...attention({ id }),
      response: body,
      state: "closed",
      closedAt: "2026-05-28T12:01:00.000Z",
    }),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AttentionCard DOM interactions", () => {
  it("submits the selected single-choice answer and the collapsed recommended answer", async () => {
    const { AttentionCard } = await import("../attention-card.js");
    const onResponded = vi.fn();
    const { container, root } = await renderDom(<AttentionCard attention={attention()} onResponded={onResponded} />);

    expect(container.textContent).toContain("Choose rollout scope");
    await click(button(container, "Wait"));
    await click(button(container, "Submit selection"));

    expect(attentionApiMocks.respondAttention).toHaveBeenCalledWith("attention-123456789", {
      answers: { default: "later" },
    });
    await flush();
    expect(onResponded).toHaveBeenCalled();

    attentionApiMocks.respondAttention.mockClear();
    await click(button(container, "Collapse"));
    await click(button(container, "Ship now"));
    expect(attentionApiMocks.respondAttention).toHaveBeenCalledWith("attention-123456789", {
      answers: { default: "now" },
    });

    await act(async () => root.unmount());
  });

  it("handles multi-question answers, escape clearing, and free-form replies", async () => {
    const { AttentionCard } = await import("../attention-card.js");
    const multi = attention({
      metadata: {
        questions: [
          {
            id: "scope",
            prompt: "Which scope?",
            context: "Pick a deployment target.",
            options: {
              mode: "multi",
              min: 1,
              max: 2,
              defaultValue: ["api"],
              items: [
                { value: "api", label: "API" },
                { value: "web", label: "Web" },
              ],
            },
          },
          {
            id: "window",
            prompt: "When?",
            options: {
              mode: "single",
              items: [
                { value: "now", label: "Now" },
                { value: "later", label: "Later" },
              ],
            },
          },
        ],
      },
    });
    const { container, root } = await renderDom(<AttentionCard attention={multi} />);

    await click(button(container, "Web"));
    await click(button(container, "Later"));
    await act(async () => {
      container
        .querySelector("[data-attention-id]")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(button(container, "Submit selection").disabled).toBe(true);

    await click(button(container, "API"));
    await click(button(container, "Now"));
    await act(async () => {
      container
        .querySelector("[data-attention-id]")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(attentionApiMocks.respondAttention).toHaveBeenCalledWith("attention-123456789", {
      answers: { scope: ["api"], window: "now" },
    });

    attentionApiMocks.respondAttention.mockClear();
    await click(button(container, "Switch to free-form"));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Expected free-form textarea");
    await setValue(textarea, "Please wait for the database window.");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    await flush();
    expect(attentionApiMocks.respondAttention).toHaveBeenCalledWith("attention-123456789", {
      text: "Please wait for the database window.",
    });

    await act(async () => root.unmount());
  });

  it("renders free-form-only, collapsed multi-select, and submit errors", async () => {
    const { AttentionCard } = await import("../attention-card.js");
    attentionApiMocks.respondAttention.mockRejectedValueOnce(new Error("server rejected answer"));

    const freeOnly = attention({ metadata: {}, body: "" });
    const free = await renderDom(<AttentionCard attention={freeOnly} />);
    const textarea = free.container.querySelector<HTMLTextAreaElement>("textarea");
    if (!textarea) throw new Error("Expected textarea");
    await setValue(textarea, "Approved with caution.");
    await click(button(free.container, "Reply"));
    await flush();
    expect(free.container.textContent).toContain("server rejected answer");
    await act(async () => free.root.unmount());

    const multiSelect = attention({
      metadata: {
        options: {
          mode: "multi",
          defaultValue: ["api"],
          items: [
            { value: "api", label: "API" },
            { value: "web", label: "Web" },
          ],
        },
      },
    });
    const collapsed = await renderDom(<AttentionCard attention={multiSelect} />);
    await click(button(collapsed.container, "Collapse"));
    expect(collapsed.container.textContent).toContain("Multi-select");
    await click(button(collapsed.container, "expand"));
    expect(collapsed.container.textContent).toContain("Choose rollout scope");
    await act(async () => collapsed.root.unmount());
  });
});
