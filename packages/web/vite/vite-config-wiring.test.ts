import type { PluginOption, UserConfig } from "vite";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";
import { API_PROXY_CONTEXT } from "./authority-firewall.js";

function pluginNames(value: readonly PluginOption[]): string[] {
  const names: string[] = [];
  for (const plugin of value) {
    if (Array.isArray(plugin)) {
      names.push(...pluginNames(plugin));
      continue;
    }
    if (plugin && typeof plugin === "object" && "name" in plugin && typeof plugin.name === "string") {
      names.push(plugin.name);
    }
  }
  return names;
}

describe("Vite authority-firewall wiring", () => {
  it("guards the exact API proxy and leaves all API upgrades to the firewall", () => {
    expect(viteConfig).toBeTypeOf("object");
    const config = viteConfig as UserConfig;
    expect(pluginNames(config.plugins ?? [])).toContain("first-tree:authority-firewall");

    const proxy = config.server?.proxy;
    expect(proxy).toBeDefined();
    expect(Object.keys(proxy ?? {})).toEqual([API_PROXY_CONTEXT]);
    expect(proxy?.[API_PROXY_CONTEXT]).toMatchObject({ changeOrigin: true });
    for (const entry of Object.values(proxy ?? {})) {
      if (typeof entry === "string") continue;
      expect(entry.ws).not.toBe(true);
    }
  });
});
