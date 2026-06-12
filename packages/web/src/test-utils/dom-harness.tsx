import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * Shared DOM test harness for happy-dom component tests (issue 1000).
 *
 * Several DOM test files used to hand-roll the same ~25 lines: a `createRoot`
 * render-into-act helper, a double-microtask `flush`, and a retrying
 * `waitFor`. When React batching / act timing changes, every private copy has
 * to be updated — this module is the single shared copy.
 *
 * Usage:
 *   let h: DomHarness;
 *   beforeEach(() => { h = createDomHarness(); });
 *   afterEach(() => h.cleanup());
 *   ...
 *   h.render(<MemoryRouter>{ui}</MemoryRouter>);  // caller owns providers
 *   await h.waitFor(() => expect(...));
 *
 * The harness deliberately does NOT bake in providers (router, react-query):
 * each test composes its own wrapper, since provider needs differ per suite.
 */

declare global {
  // eslint-style global used by React to silence act() warnings in tests.
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export type DomHarness = {
  /** Render (or re-render) the element into this harness's container. */
  render: (ui: ReactElement) => void;
  /** Flush pending microtasks twice inside act() — settles most effects. */
  flush: () => Promise<void>;
  /** Retry `assertion` across up to 25 flushes until it stops throwing. */
  waitFor: (assertion: () => void) => Promise<void>;
  /** The detached container element the harness rendered into. */
  container: HTMLElement;
  /** Unmount the root, remove the container, and clear document.body. */
  cleanup: () => void;
};

/**
 * Create a fresh harness (one per test via `beforeEach`). Also normalizes the
 * happy-dom viewport to a desktop-ish size so positioning code (portals,
 * popovers) sees sane dimensions; override per-test with `setViewportSize`.
 */
export function createDomHarness(): DomHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  setViewportSize(1400, 900);

  const render = (ui: ReactElement): void => {
    act(() => {
      root.render(ui);
    });
  };

  const flush = (): Promise<void> =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  const waitFor = async (assertion: () => void): Promise<void> => {
    let lastErr: unknown;
    for (let i = 0; i < 25; i++) {
      try {
        assertion();
        return;
      } catch (err) {
        lastErr = err;
      }
      await flush();
    }
    throw lastErr;
  };

  const cleanup = (): void => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
  };

  return { render, flush, waitFor, container, cleanup };
}

/** Set the happy-dom window dimensions (configurable, test-only). */
export function setViewportSize(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}
