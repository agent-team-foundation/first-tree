// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, WorkingChip } from "../working-chip.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function renderChip(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-31T00:00:05.000Z"));
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("formatElapsed — WorkingChip ticker formatter", () => {
  it("sub-second values render with a tenths decimal", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(400)).toBe("0.4s");
    expect(formatElapsed(999)).toBe("1.0s"); // rounded by toFixed(1)
  });

  it("1s..59s render as integer seconds without a decimal", () => {
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(12_500)).toBe("12s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("60s+ render as Mm SSs with zero-padded seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m00s");
    expect(formatElapsed(83_000)).toBe("1m23s");
    expect(formatElapsed(3_600_000)).toBe("60m00s");
  });

  it("negative values clamp to 0s (clock skew safety)", () => {
    expect(formatElapsed(-1)).toBe("0s");
    expect(formatElapsed(-5_000)).toBe("0s");
  });

  it("renders the live chip with dot, prefix, monochrome timer, and ticker updates", async () => {
    const container = await renderChip(
      <WorkingChip
        activity={{ agentId: "agent-1", kind: "tool_call", label: "Bash", startedAt: "2026-05-31T00:00:00.000Z" }}
        prefix="Working"
        monochrome
      />,
    );

    expect(container.querySelector(".chat-row-live-chip__dot")).toBeTruthy();
    expect(container.textContent).toContain("Working · Bash");
    expect(container.textContent).toContain("5s");
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Working, Bash, 5s");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toContain("6s");
  });

  it("can render without the pulse dot", async () => {
    const container = await renderChip(
      <WorkingChip
        activity={{
          agentId: "agent-1",
          kind: "thinking",
          label: "Thinking",
          startedAt: "2026-05-31T00:00:04.500Z",
        }}
        showDot={false}
      />,
    );

    expect(container.querySelector(".chat-row-live-chip__dot")).toBeNull();
    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("0.5s");
  });
});
