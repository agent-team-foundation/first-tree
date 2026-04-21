import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { DEFAULT_DATA_DIR } from "@agent-team-foundation/first-tree-hub-shared/config";
import type { FastifyInstance } from "fastify";
import { requireMember } from "../../middleware/require-identity.js";

const UPLOADS_DIR = join(DEFAULT_DATA_DIR, "uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);

function ensureUploadsDir(): void {
  if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

export async function adminUploadRoutes(app: FastifyInstance): Promise<void> {
  ensureUploadsDir();

  /** POST /admin/uploads — upload a file, returns URL */
  app.post("/", async (request, reply) => {
    requireMember(request);

    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: "No file provided" });
    }

    const mimeType = data.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return reply.status(400).send({
        error: `Unsupported file type: ${mimeType}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}`,
      });
    }

    // Generate unique filename
    const ext = extname(data.filename) || mimeExtension(mimeType);
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const uniqueName = `${timestamp}_${randomUUID().slice(0, 8)}${ext}`;
    const filePath = join(UPLOADS_DIR, uniqueName);

    // Stream file to disk with size check
    let totalSize = 0;
    const writeStream = createWriteStream(filePath);

    try {
      const fileStream = data.file;
      for await (const chunk of fileStream) {
        totalSize += chunk.length;
        if (totalSize > MAX_FILE_SIZE) {
          writeStream.destroy();
          try {
            unlinkSync(filePath);
          } catch {}
          return reply.status(400).send({
            error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024}MB`,
          });
        }
        writeStream.write(chunk);
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
      });
    } catch (err) {
      writeStream.destroy();
      throw err;
    }

    const url = `/api/v1/admin/uploads/${uniqueName}`;

    return reply.status(201).send({
      url,
      filename: data.filename,
      storedName: uniqueName,
      mimeType,
      size: totalSize,
    });
  });

  /** GET /admin/uploads/:filename — serve uploaded file */
  app.get<{ Params: { filename: string } }>("/:filename", async (request, reply) => {
    requireMember(request);

    const { filename } = request.params;
    if (filename.includes("/") || filename.includes("..")) {
      return reply.status(400).send({ error: "Invalid filename" });
    }

    const filePath = join(UPLOADS_DIR, filename);
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: "File not found" });
    }

    const ext = extname(filename).toLowerCase();
    const contentType = extensionToMime(ext) ?? "application/octet-stream";

    const stream = createReadStream(filePath);
    return reply.type(contentType).send(stream);
  });
}

function mimeExtension(mime: string): string {
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    default:
      return "";
  }
}

function extensionToMime(ext: string): string | null {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return null;
  }
}
