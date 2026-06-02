// @vitest-environment happy-dom

import type { PulseBucket } from "@first-tree/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PulseProvider, usePulse } from "../pulse-context.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const wsMock = vi.hoisted(() => ({
  onMessage: null as ((msg: unknown) => void) | null,
}));

vi.mock("../use-admin-ws.js", () => ({
  useAdminWs: ({ onMessage }: { onMessage: (msg: unknown) => void }) => {
    wsMock.onMessage = onMessage;
  },
}));

let root: Root | null = null;
let latest: ReturnType<typeof usePulse> | null = null;

function buckets(count: number, errorMask = false): PulseBucket[] {
  return Array.from({ length: 32 }, (_, index) => ({ workingCount: index === 0 ? count : 0, errorMask }));
}

function Probe({ children }: { children?: ReactNode }) {
  latest = usePulse();
  return <div>{children ?? `${latest.aggregated[0]?.workingCount ?? 0}:${latest.stale ? "stale" : "fresh"}`}</div>;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderProbe(element: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  await flush();
  return container;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-31T00:00:00.000Z"));
  latest = null;
  wsMock.onMessage = null;
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

function pulse() {
  if (!latest) throw new Error("pulse was not captured");
  return latest;
}

describe("PulseProvider", () => {
  it("provides a stale empty baseline outside the provider", async () => {
    const container = await renderProbe(<Probe />);

    expect(container.textContent).toBe("0:stale");
    expect(pulse().receivedAtMs).toBeNull();
    expect(pulse().agents).toEqual({});
  });

  it("accepts valid pulse ticks, ignores invalid frames, and flips stale after the interval", async () => {
    const container = await renderProbe(
      <PulseProvider>
        <Probe />
      </PulseProvider>,
    );

    expect(container.textContent).toBe("0:stale");
    await act(async () => {
      wsMock.onMessage?.({ type: "unknown" });
    });
    expect(container.textContent).toBe("0:stale");

    await act(async () => {
      wsMock.onMessage?.({
        type: "pulse:tick",
        organizationId: "org-1",
        agents: {
          "agent-1": buckets(2),
          "agent-2": buckets(3, true),
        },
      });
    });
    await flush();

    expect(container.textContent).toBe("5:fresh");
    expect(pulse().aggregated[0]).toEqual({ workingCount: 5, errorMask: true });
    expect(pulse().receivedAtMs).toBe(new Date("2026-05-31T00:00:00.000Z").getTime());

    await act(async () => {
      vi.advanceTimersByTime(40_000);
    });
    expect(container.textContent).toBe("5:stale");
  });
});
