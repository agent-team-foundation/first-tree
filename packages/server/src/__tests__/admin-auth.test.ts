import { afterAll, describe, expect, it } from "vitest";
import { createTestAdmin, createTestApp } from "./helpers.js";

describe("Admin Auth", () => {
  const appPromise = createTestApp();
  afterAll(async () => (await appPromise).close());

  describe("POST /admin/auth/login", () => {
    it("returns tokens on valid credentials", async () => {
      const app = await appPromise;
      const admin = await createTestAdmin(app);
      expect(admin.accessToken).toBeDefined();
      expect(admin.refreshToken).toBeDefined();
    });

    it("rejects invalid password", async () => {
      const app = await appPromise;
      await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/admin/auth/login",
        payload: { username: "admin", password: "wrong" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects non-existent user", async () => {
      const app = await appPromise;
      const res = await app.inject({
        method: "POST",
        url: "/admin/auth/login",
        payload: { username: "nobody", password: "whatever" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /admin/auth/refresh", () => {
    it("returns new access token", async () => {
      const app = await appPromise;
      const admin = await createTestAdmin(app);
      const res = await app.inject({
        method: "POST",
        url: "/admin/auth/refresh",
        payload: { refreshToken: admin.refreshToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty("accessToken");
    });

    it("rejects invalid refresh token", async () => {
      const app = await appPromise;
      const res = await app.inject({
        method: "POST",
        url: "/admin/auth/refresh",
        payload: { refreshToken: "invalid" },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
