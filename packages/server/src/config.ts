import { randomUUID } from "node:crypto";

const env = process.env;

export type Config = {
  databaseUrl: string;
  serverHost: string;
  serverPort: number;
  jwtSecretKey: string;
  instanceId: string;
  logger?: boolean;
  githubWebhookSecret?: string;
  webDistPath?: string;
  adapterEncryptionKey?: string;
};

export function loadConfig(): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const jwtSecretKey = env.JWT_SECRET_KEY;
  if (!jwtSecretKey) {
    throw new Error("JWT_SECRET_KEY is required");
  }

  return {
    databaseUrl,
    serverHost: env.SERVER_HOST ?? "0.0.0.0",
    serverPort: Number(env.SERVER_PORT ?? "8000"),
    jwtSecretKey,
    instanceId: env.INSTANCE_ID ?? `srv_${randomUUID().slice(0, 8)}`,
    githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET || undefined,
    webDistPath: env.WEB_DIST_PATH,
    adapterEncryptionKey: env.ADAPTER_ENCRYPTION_KEY || undefined,
  };
}
