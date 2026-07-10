import { describe, expect, it } from "vitest";
import type { ServiceInfo } from "../core/service-install.js";
import { shouldRestartServiceAfterRefresh } from "../core/service-recovery.js";

function service(overrides: Partial<ServiceInfo>): ServiceInfo {
  return {
    platform: "task-scheduler",
    state: "inactive",
    label: "\\FirstTree\\first-tree-dev",
    unitPath: "C:\\Users\\test\\.first-tree\\service\\first-tree-dev-task.xml",
    logDir: "C:\\Users\\test\\.first-tree\\logs",
    ...overrides,
  };
}

describe("shouldRestartServiceAfterRefresh", () => {
  it("restarts active services after refreshing service files", () => {
    expect(shouldRestartServiceAfterRefresh(service({ state: "active" }))).toBe(true);
  });

  it("restarts Windows Task Scheduler unknown states that still have live service evidence", () => {
    expect(
      shouldRestartServiceAfterRefresh(
        service({
          state: "unknown",
          detail: "task running but no live service runtime marker",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRestartServiceAfterRefresh(
        service({
          state: "unknown",
          detail: "service runtime marker is live but task state is unavailable",
        }),
      ),
    ).toBe(true);
    expect(
      shouldRestartServiceAfterRefresh(
        service({
          state: "unknown",
          detail: "supervisor process is still live after task stop",
        }),
      ),
    ).toBe(true);
  });

  it("does not restart inactive or unsupported unknown states", () => {
    expect(shouldRestartServiceAfterRefresh(service({ state: "inactive" }))).toBe(false);
    expect(
      shouldRestartServiceAfterRefresh(
        service({
          state: "unknown",
          detail: "task query failed",
        }),
      ),
    ).toBe(false);
    expect(
      shouldRestartServiceAfterRefresh(
        service({
          platform: "launchd",
          state: "unknown",
          detail: "task running but no live service runtime marker",
        }),
      ),
    ).toBe(false);
  });
});
