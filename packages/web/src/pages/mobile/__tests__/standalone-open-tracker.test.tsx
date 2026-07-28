// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness } from "../../../test-utils/dom-harness.js";
import { MobileStandaloneOpenTracker } from "../standalone-open-tracker.js";

const mocks = vi.hoisted(() => ({
  standalone: true,
  trackEvent: vi.fn(),
}));

vi.mock("../../../analytics.js", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("../install-guide-state.js", () => ({ isStandalone: () => mocks.standalone }));

describe("MobileStandaloneOpenTracker", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.standalone = true;
    mocks.trackEvent.mockReset();
  });

  it("records a standalone first open before auth and deduplicates later mounts", async () => {
    const first = createDomHarness();
    first.render(<MobileStandaloneOpenTracker />);
    await first.flush();
    expect(mocks.trackEvent).toHaveBeenCalledWith("mobile_standalone_first_open");
    first.cleanup();

    const second = createDomHarness();
    second.render(<MobileStandaloneOpenTracker />);
    await second.flush();
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    second.cleanup();
  });

  it("does not record ordinary browser opens", async () => {
    mocks.standalone = false;
    const harness = createDomHarness();
    harness.render(<MobileStandaloneOpenTracker />);
    await harness.flush();
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    harness.cleanup();
  });
});
