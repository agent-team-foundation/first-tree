import { loadEnv } from "vite";
import { resolveViteBrowserEnvironment } from "./src/browser-resource-policy.js";

/** Load the exact mode-specific Web env directory, then apply Vite's process precedence. */
export function loadViteBrowserEnvironment(
  mode: string,
  envDir: string,
  processEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return resolveViteBrowserEnvironment(loadEnv(mode, envDir, "VITE_"), processEnvironment);
}
