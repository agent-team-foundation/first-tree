import { execSync } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_SECURITY_MANIFEST_FILENAME,
  type BrowserSecurityManifest,
  browserSecurityManifestSchema,
  WEB_VERSION_MANIFEST_FILENAME,
} from "@first-tree/shared";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { assertBuildHtmlSecurity } from "./build-html-security.js";
import { buildBrowserSecurityManifest } from "./src/browser-resource-policy.js";
import { loadViteBrowserEnvironment } from "./vite-environment.js";

const SENTRY_WEB_PROJECT = "first-tree-web";
const WEB_ROOT = fileURLToPath(new URL(".", import.meta.url));
const DIST_ROOT = join(WEB_ROOT, "dist");

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

function deleteSourceMapsPlugin(distRoot: string): Plugin {
  return {
    name: "first-tree:delete-source-maps",
    apply: "build",
    enforce: "post",
    async closeBundle() {
      await deleteSourceMaps(join(distRoot, "assets")).catch((error: unknown) => {
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
        fileName: WEB_VERSION_MANIFEST_FILENAME,
        source: JSON.stringify({ buildId }),
      });
    },
  };
}

function browserSecurityManifestPlugin(manifest: BrowserSecurityManifest): Plugin {
  return {
    name: "first-tree:browser-security-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: BROWSER_SECURITY_MANIFEST_FILENAME,
        source: JSON.stringify(manifest),
      });
    },
  };
}

async function readableBuildFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readableBuildFiles(path)));
    } else if (entry.isFile() && /\.(?:css|html|js)$/u.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

function browserSecurityBuildVerifierPlugin(distRoot: string, expectedBuildId: string): Plugin {
  return {
    name: "first-tree:verify-browser-security-build",
    apply: "build",
    enforce: "post",
    async closeBundle() {
      const indexPath = join(distRoot, "index.html");
      const indexHtml = await readFile(indexPath, "utf8");
      assertBuildHtmlSecurity(indexHtml);
      await readFile(join(distRoot, "theme-init.js"), "utf8");

      const manifestText = await readFile(join(distRoot, BROWSER_SECURITY_MANIFEST_FILENAME), "utf8");
      const manifest = browserSecurityManifestSchema.parse(JSON.parse(manifestText));
      const versionText = await readFile(join(distRoot, WEB_VERSION_MANIFEST_FILENAME), "utf8");
      const version: unknown = JSON.parse(versionText);
      const versionBuildId =
        typeof version === "object" && version !== null && "buildId" in version
          ? Reflect.get(version, "buildId")
          : undefined;
      if (manifest.buildId !== expectedBuildId || versionBuildId !== expectedBuildId) {
        throw new Error("Browser security build verification failed: emitted build IDs do not match");
      }

      const files = await readableBuildFiles(distRoot);
      for (const file of files) {
        const contents = await readFile(file, "utf8");
        if (contents.includes("chat-row-avatar-preview--freeze")) {
          throw new Error("Browser security build verification failed: dev-only avatar preview style was emitted");
        }
      }
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

export default defineConfig(({ mode }) => {
  const browserEnvironment = loadViteBrowserEnvironment(mode, WEB_ROOT, process.env);
  const browserSecurityManifest = browserSecurityManifestSchema.parse(
    buildBrowserSecurityManifest(buildId, browserEnvironment),
  );
  const hubTarget = browserEnvironment.VITE_PROXY_TARGET ?? "http://localhost:8000";

  return {
    root: WEB_ROOT,
    envDir: WEB_ROOT,
    build: {
      sourcemap: "hidden",
    },
    plugins: [
      react(),
      tailwindcss(),
      versionManifestPlugin(buildId),
      browserSecurityManifestPlugin(browserSecurityManifest),
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
      browserSecurityBuildVerifierPlugin(DIST_ROOT, buildId),
      deleteSourceMapsPlugin(DIST_ROOT),
    ],
    define: {
      __WEB_BUILD_ID__: JSON.stringify(buildId),
    },
    server: {
      proxy: {
        "/api/v1": { target: hubTarget, changeOrigin: true, ws: true },
      },
    },
  };
});
