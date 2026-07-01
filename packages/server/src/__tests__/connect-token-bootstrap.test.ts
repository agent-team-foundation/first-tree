import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("POST /me/connect-tokens bootstrap method", () => {
  describe("prod default", () => {
    const getApp = useTestApp({ channel: "prod" });

    it("returns npm bootstrap by default for published channels", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        npmSpec: string | null;
        installMethod: string;
        installerUrl: string | null;
        binName: string;
      }>();
      expect(body.binName).toBe("first-tree");
      expect(body.npmSpec).toBe("first-tree");
      expect(body.installMethod).toBe("npm");
      expect(body.installerUrl).toBeNull();
      expect(body.bootstrapCommand).toBe(`npm install -g first-tree\nfirst-tree login ${body.token}`);
    });
  });

  describe("prod portable", () => {
    const getApp = useTestApp({
      channel: "prod",
      connectBootstrap: {
        method: "portable",
        portableDownloadBaseUrl: "https://downloads.example.test/releases",
      },
    });

    it("returns a token-free installer URL and a local login command", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        npmSpec: string | null;
        installMethod: string;
        installerUrl: string | null;
        binName: string;
      }>();
      expect(body.installMethod).toBe("portable");
      expect(body.npmSpec).toBe("first-tree");
      expect(body.installerUrl).toBe("https://downloads.example.test/releases/prod/install.sh");
      expect(body.installerUrl).not.toContain(body.token);
      expect(body.bootstrapCommand).toContain('tmp="$(mktemp "$' + '{TMPDIR:-/tmp}/first-tree-install.XXXXXX")"');
      expect(body.bootstrapCommand).toContain(`trap 'rm -f "$tmp"' EXIT HUP INT TERM`);
      expect(body.bootstrapCommand).toContain("curl -fsSL 'https://downloads.example.test/releases/prod/install.sh'");
      expect(body.bootstrapCommand).toContain(
        "FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL='https://downloads.example.test/releases' sh \"$tmp\"",
      );
      expect(body.bootstrapCommand).toContain(`"$HOME/.local/bin/first-tree" login '${body.token}'`);
      expect(body.bootstrapCommand).toContain(" && \\");
      expect(body.bootstrapCommand).not.toContain("/tmp/first-tree-install-first-tree.sh");
      expect(body.bootstrapCommand).not.toContain(`${body.installerUrl}?token=`);
    });
  });

  describe("dev source", () => {
    const getApp = useTestApp({
      channel: "dev",
      connectBootstrap: {
        method: "portable",
        portableDownloadBaseUrl: "https://downloads.example.test/releases",
      },
    });

    it("keeps dev source bootstrap even when portable mode is requested", async () => {
      const app = getApp();
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/me/connect-tokens",
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        token: string;
        command: string;
        bootstrapCommand: string;
        npmSpec: string | null;
        installMethod: string;
        installerUrl: string | null;
      }>();
      expect(body.installMethod).toBe("source");
      expect(body.npmSpec).toBeNull();
      expect(body.installerUrl).toBeNull();
      expect(body.bootstrapCommand).toBe(`first-tree-dev login ${body.token}`);
    });
  });
});
