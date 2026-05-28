import { afterEach, describe, expect, it } from "vitest";
import { getConfig, resetConfig, setConfig } from "../singleton.js";

describe("config singleton", () => {
  afterEach(() => {
    resetConfig();
  });

  it("throws when read before initialization", () => {
    resetConfig();

    expect(() => getConfig()).toThrow("Config not initialized. Call initConfig() first.");
  });

  it("returns the initialized config object", () => {
    const config = { server: { url: "http://localhost:8000" } };
    setConfig(config);

    expect(getConfig()).toBe(config);
  });
});
