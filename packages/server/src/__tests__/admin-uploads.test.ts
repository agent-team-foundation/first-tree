import { describe, expect, it } from "vitest";
import { createTestAdmin, useTestApp } from "./helpers.js";

describe("Admin Uploads API", () => {
  const getApp = useTestApp();

  it("uploads an image and retrieves it", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    // Create a minimal 1x1 PNG
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64",
    );

    // Build multipart form data manually
    const boundary = "----TestBoundary123";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      pngBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const uploadRes = await app.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(uploadRes.statusCode).toBe(201);
    const result = uploadRes.json();
    expect(result.url).toMatch(/^\/api\/v1\/uploads\//);
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("test.png");
    expect(result.size).toBeGreaterThan(0);

    // Retrieve the uploaded file (public route, no auth needed)
    const getRes = await app.inject({
      method: "GET",
      url: result.url,
    });

    expect(getRes.statusCode).toBe(200);
    expect(getRes.headers["content-type"]).toContain("image/png");
  });

  it("rejects non-image file types", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);

    const boundary = "----TestBoundary456";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hack.exe"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from("not an image"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unsupported file type");
  });

  it("rejects unauthenticated upload", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/uploads",
    });

    expect(res.statusCode).toBe(401);
  });

  it("returns 404 for non-existent file", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/uploads/nonexistent.png",
    });

    expect(res.statusCode).toBe(404);
  });

  it("rejects path traversal in filename", async () => {
    const app = getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/uploads/..%2F..%2Fetc%2Fpasswd",
    });

    // Should be 400 or 404, not serve the file
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
