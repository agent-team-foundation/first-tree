const env = process.env;

export type Config = {
  databaseUrl: string;
  serverHost: string;
  serverPort: number;
  jwtSecretKey: string;
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
  };
}
