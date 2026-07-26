// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEventRow } from "../../../api/sessions.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-05-28T12:00:00.000Z";

function event(overrides: Partial<SessionEventRow> & Pick<SessionEventRow, "id" | "kind" | "seq">): SessionEventRow {
  return {
    agentId: overrides.agentId ?? "agent-1",
    chatId: overrides.chatId ?? "chat-1",
    payload: overrides.payload ?? {},
    createdAt: overrides.createdAt ?? NOW,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByLabel(container: ParentNode, label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

const props = {
  agentNameFn: (id: string) => (id === "agent-1" ? "Nova" : id),
  agentAvatarFn: (id: string) => `https://example.test/${id}.png`,
  agentColorTokenFn: () => "hue-2",
};

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("WorkingTurn", () => {
  it("renders latest assistant body, expanded process lines, collapse state, and elapsed time", async () => {
    const { WorkingTurn } = await import("../working-turn.js");
    const events: SessionEventRow[] = [
      event({ id: "assistant-1", seq: 1, kind: "assistant_text", payload: { text: "Starting..." } }),
      event({
        id: "tool-1",
        seq: 2,
        kind: "tool_call",
        payload: { toolUseId: "bash-1", name: "Bash", args: { command: "pnpm test\npnpm check" }, status: "pending" },
      }),
      event({ id: "thinking-1", seq: 3, kind: "thinking" }),
      event({
        id: "tool-2",
        seq: 4,
        kind: "tool_call",
        payload: {
          toolUseId: "read-1",
          name: "Read",
          args: { file_path: "/repo/packages/web/src/app.tsx" },
          status: "ok",
          durationMs: 1234,
          resultPreview: "\nexport function App() {}",
        },
      }),
      event({ id: "assistant-2", seq: 5, kind: "assistant_text", payload: { text: "Latest progress update" } }),
    ];

    const { container, root } = await renderDom(<WorkingTurn {...props} events={events} defaultOpen />);
    expect(container.querySelector("[data-working-agent='agent-1']")).not.toBeNull();
    expect(container.textContent).toContain("Nova");
    expect(container.textContent).toContain("working · 0s");
    expect(container.textContent).toContain("Latest progress update");
    expect(container.textContent).not.toContain("Starting...");
    expect(container.textContent).toContain("run");
    expect(container.textContent).toContain("pnpm test");
    expect(container.textContent).toContain("thinking");
    expect(container.textContent).toContain("read");
    expect(container.textContent).toContain("app.tsx");
    expect(container.textContent).toContain("1.2s");
    expect(container.textContent).toContain("export function App() {}");
    expect(container.textContent).toContain("▴ 2 tools · 1 thinking");

    vi.setSystemTime(new Date("2026-05-28T12:01:02.000Z"));
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toContain("working · 1m03s");

    await click(buttonByLabel(container, "Collapse working details"));
    expect(container.textContent).toContain("▾ 3 steps");
    expect(container.textContent).toContain("read");
    expect(container.textContent).not.toContain("pnpm test");

    await click(buttonByLabel(container, "Expand working details"));
    expect(container.textContent).toContain("pnpm test");

    await act(async () => root.unmount());
  });

  it("covers collapsed single-step, error, unknown tool, empty, and malformed payload paths", async () => {
    const { WorkingTurn } = await import("../working-turn.js");

    const empty = await renderDom(<WorkingTurn {...props} events={[]} defaultOpen={false} />);
    expect(empty.container.textContent).toBe("");
    await act(async () => empty.root.unmount());

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { container, root } = await renderDom(
      <WorkingTurn
        {...props}
        defaultOpen={false}
        events={[
          event({
            id: "tool-bad",
            seq: 1,
            kind: "tool_call",
            payload: { toolUseId: "bad", name: "Bash", status: "running" },
          }),
          event({
            id: "tool-err",
            seq: 2,
            kind: "tool_call",
            payload: {
              toolUseId: "tool-err",
              name: "MysteryTool",
              args: circular,
              status: "error",
              durationMs: 42,
              resultPreview: "\n  failed hard\nsecond line",
            },
          }),
          event({ id: "ignored", seq: 3, kind: "token_usage", payload: {} }),
        ]}
      />,
    );

    expect(container.textContent).toContain("use");
    expect(container.textContent).toContain("MysteryTool");
    expect(container.textContent).toContain("42ms");
    expect(container.textContent).toContain("failed hard");
    expect(container.textContent).toContain("▾ 2 steps");

    await act(async () => root.unmount());
  });

  it("strips codex login-shell wrappers from command tool display", async () => {
    const { WorkingTurn } = await import("../working-turn.js");
    const wrapped = "/bin/zsh -lc \"sed -n '1,40p' /home/op/context-tree/NODE.md\"";
    const { container, root } = await renderDom(
      <WorkingTurn
        {...props}
        defaultOpen
        events={[
          event({
            id: "codex-command",
            seq: 1,
            kind: "tool_call",
            payload: {
              toolUseId: "cmd-1",
              name: "command",
              args: { command: wrapped, cwd: "/home/op/repo" },
              status: "pending",
            },
          }),
        ]}
      />,
    );

    expect(container.textContent).toContain("run");
    expect(container.textContent).toContain("sed -n '1,40p' /home/op/context-tree/NODE.md");
    expect(container.textContent).not.toContain("/bin/zsh");
    expect(container.textContent).not.toContain("-lc");

    const titles = Array.from(container.querySelectorAll<HTMLElement>("[title]")).map((el) => el.title);
    expect(titles.join("\n")).toContain("sed -n '1,40p' /home/op/context-tree/NODE.md");
    expect(titles.join("\n")).not.toContain("/bin/zsh");

    await act(async () => root.unmount());
  });

  it("wraps long agent names and assistant updates inside a narrow timeline", async () => {
    const { WorkingTurn } = await import("../working-turn.js");
    const longName = `agent-${"unbroken".repeat(20)}`;
    const longBody = `progress-${"unbroken".repeat(40)}`;
    const { container, root } = await renderDom(
      <WorkingTurn
        {...props}
        agentNameFn={() => longName}
        defaultOpen={false}
        events={[event({ id: "assistant-long", seq: 1, kind: "assistant_text", payload: { text: longBody } })]}
      />,
    );

    expect(container.querySelector<HTMLElement>("[data-working-turn-header]")?.className).toContain("flex-wrap");
    expect(container.querySelector<HTMLElement>("[data-working-turn-name]")?.style.overflowWrap).toBe("anywhere");
    expect(container.querySelector<HTMLElement>("[data-working-turn-body]")?.style.overflowWrap).toBe("anywhere");
    expect(container.textContent).toContain(longName);
    expect(container.textContent).toContain(longBody);

    await act(async () => root.unmount());
  });
});
