import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadViteBrowserEnvironment } from "./vite-environment.js";

describe("loadViteBrowserEnvironment", () => {
  it("loads .env.<mode> from the exact envDir and gives process values precedence", async () => {
    const envDir = await mkdtemp(join(tmpdir(), "first-tree-web-env-"));
    try {
      await writeFile(
        join(envDir, ".env.security-contract"),
        [
          "VITE_SENTRY_DSN=https://file@example.ingest.sentry.io/1",
          "VITE_SENTRY_ENABLED=false",
          "VITE_MODE_FILE_ONLY=loaded",
          "IGNORED_WITHOUT_PREFIX=yes",
        ].join("\n"),
      );

      expect(
        loadViteBrowserEnvironment("security-contract", envDir, {
          VITE_SENTRY_DSN: "https://process@example.ingest.sentry.io/2",
          VITE_SENTRY_ENABLED: "true",
          VITE_PROCESS_ONLY: "added",
          SENTRY_AUTH_TOKEN: "not-browser-visible",
        }),
      ).toEqual({
        VITE_SENTRY_DSN: "https://process@example.ingest.sentry.io/2",
        VITE_SENTRY_ENABLED: "true",
        VITE_MODE_FILE_ONLY: "loaded",
        VITE_PROCESS_ONLY: "added",
      });
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
