import { execSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { normalizeViteProxyTarget } from "./vite/authority-firewall.js";

const HUB_TARGET = normalizeViteProxyTarget(process.env.VITE_PROXY_TARGET ?? "http://localhost:8000");
const SENTRY_WEB_PROJECT = "first-tree-web";

/**
 * A unique id for this web build. Resolution order:
 *   1. `FIRST_TREE_WEB_BUILD_ID` — explicit override (e.g. a CI-passed git
 *      SHA, mirroring the `COMMAND_VERSION` build-arg the Docker image uses).
 *   2. `git rev-parse HEAD` — when building from a checkout with `.git`.
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
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return `build-${Date.now()}`;
  }
}

function deleteSourceMapsPlugin(): Plugin {
  return {
    name: "first-tree:delete-source-maps",
    apply: "build",
    enforce: "post",
    async closeBundle() {
      await deleteSourceMaps("dist/assets").catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Sentry source map cleanup skipped: ${message}`);
      });
    },
  };
}

async function deleteSourceMaps(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await deleteSourceMaps(path);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".map")) {
        await rm(path, { force: true });
      }
    }),
  );
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
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN?.trim();
const sentryOrg = process.env.SENTRY_ORG?.trim();
const sentryProject = process.env.SENTRY_PROJECT_WEB?.trim() || SENTRY_WEB_PROJECT;
const sentryRelease = process.env.SENTRY_RELEASE?.trim() || `first-tree-web@${buildId}`;
const sentryPluginEnabled = Boolean(sentryAuthToken && sentryOrg);

if (!sentryPluginEnabled && process.env.CI) {
  console.warn("Sentry source map upload skipped: SENTRY_AUTH_TOKEN or SENTRY_ORG is not configured.");
}

export default defineConfig({
  build: {
    sourcemap: "hidden",
  },
  plugins: [
    react(),
    tailwindcss(),
    versionManifestPlugin(buildId),
    sentryVitePlugin({
      org: sentryOrg,
      project: sentryProject,
      authToken: sentryAuthToken,
      disable: !sentryPluginEnabled,
      telemetry: false,
      release: {
        name: sentryRelease,
        inject: false,
        setCommits: false,
      },
      sourcemaps: {
        filesToDeleteAfterUpload: "dist/assets/**/*.map",
      },
      errorHandler(error) {
        console.warn(`Sentry source map upload failed: ${error.message}`);
      },
    }),
    deleteSourceMapsPlugin(),
  ],
  define: {
    __WEB_BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    proxy: {
      "/api/v1": { target: HUB_TARGET, changeOrigin: true, ws: true },
    },
  },
});
