import { execSync } from "node:child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const HUB_TARGET = process.env.VITE_PROXY_TARGET ?? "http://localhost:8000";

/**
 * A unique id for this web build. Resolution order:
 *   1. `FIRST_TREE_WEB_BUILD_ID` — explicit override (e.g. a CI-passed git
 *      SHA, mirroring the `COMMAND_VERSION` build-arg the Docker image uses).
 *   2. `git rev-parse --short HEAD` — when building from a checkout with `.git`.
 *   3. a build timestamp — guarantees a fresh id per build when neither of the
 *      above is available (e.g. `.git` excluded from the Docker build context).
 *
 * The id is both injected into the bundle as `__WEB_BUILD_ID__` (the version
 * THIS tab is running) and written to `dist/version.json` (the version the
 * server is currently serving). The client polls the manifest and compares the
 * two to detect that a newer build has been deployed — see use-version-check.
 */
function resolveBuildId(): string {
  const fromEnv = process.env.FIRST_TREE_WEB_BUILD_ID?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return `build-${Date.now()}`;
  }
}

/**
 * Emits `version.json` ({ buildId }) into the build output so the running SPA
 * can poll for the currently deployed build id. Build-only: the dev server has
 * no bundle, so the manifest fetch simply 404s and is treated as "no new
 * version" (the chip never shows in local dev).
 */
function versionManifestPlugin(buildId: string): Plugin {
  return {
    name: "first-tree:version-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ buildId }),
      });
    },
  };
}

const buildId = resolveBuildId();

export default defineConfig({
  plugins: [react(), tailwindcss(), versionManifestPlugin(buildId)],
  define: {
    __WEB_BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    proxy: {
      "/api/v1": { target: HUB_TARGET, changeOrigin: true, ws: true },
      "/feedback": { target: HUB_TARGET, changeOrigin: true },
    },
  },
});
