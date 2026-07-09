import { describe, expect, it } from "vitest";
import { unsupportedBackend } from "../core/supervisor/unsupported.js";

describe("unsupported supervisor backend", () => {
  it("reports unsupported service metadata without throwing", () => {
    expect(unsupportedBackend.platform).toBe("unsupported");
    expect(unsupportedBackend.isSupported()).toBe(false);
    expect(unsupportedBackend.isUnitDriftDetected()).toBe(false);

    expect(unsupportedBackend.status()).toMatchObject({
      platform: "unsupported",
      state: "not-installed",
      detail: expect.stringContaining(`platform ${process.platform} not supported`),
    });
    expect(unsupportedBackend.uninstall()).toMatchObject({
      platform: "unsupported",
      state: "not-installed",
    });
  });

  it("rejects service control operations with platform-specific reasons", () => {
    for (const control of [unsupportedBackend.start, unsupportedBackend.stop, unsupportedBackend.restart]) {
      expect(control()).toEqual({
        ok: false,
        reason: `service control not supported on ${process.platform}`,
      });
    }
  });

  it("throws actionable install and refresh guidance", () => {
    expect(() => unsupportedBackend.install()).toThrow("Background service install is not supported");
    expect(() => unsupportedBackend.install()).toThrow("daemon start");
    expect(() => unsupportedBackend.refreshForUpdate()).toThrow("Background service refresh is not supported");
    expect(() => unsupportedBackend.refreshForUpdate()).toThrow("daemon start");
  });
});
