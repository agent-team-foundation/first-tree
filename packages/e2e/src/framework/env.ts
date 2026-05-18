import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");

/**
 * Tiny `.env.e2e` loader. We don't take a `dotenv` runtime dep here — the
 * framework owns one well-defined file with a fixed shape, and `process.env`
 * is the source of truth at process start, so a 20-line parser is enough.
 */
function loadEnvE2EFile(): void {
  const path = resolve(PACKAGE_ROOT, ".env.e2e");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const e2eEnvSchema = z.object({
  E2E_PG_IMAGE: z.string().default("postgres:16-alpine"),
  E2E_KEEP_LOGS: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  E2E_RUN_ID: z.string().optional(),
  E2E_PORT_MIN: z.coerce.number().int().min(1024).max(65000).default(30000),
  E2E_PORT_MAX: z.coerce.number().int().min(1024).max(65535).default(40000),
  E2E_DOCKER_COMPOSE_BIN: z.string().optional(),
});

export type E2EEnv = z.infer<typeof e2eEnvSchema>;

export function loadE2EEnv(): E2EEnv {
  loadEnvE2EFile();
  const parsed = e2eEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid .env.e2e / process.env for E2E framework:\n${issues}`);
  }
  if (parsed.data.E2E_PORT_MAX <= parsed.data.E2E_PORT_MIN) {
    throw new Error(
      `E2E_PORT_MAX (${parsed.data.E2E_PORT_MAX}) must be greater than E2E_PORT_MIN (${parsed.data.E2E_PORT_MIN})`,
    );
  }
  return parsed.data;
}

export const PACKAGE_E2E_ROOT = PACKAGE_ROOT;
export const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
