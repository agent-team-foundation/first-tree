import { generateKeyPairSync, randomBytes } from "node:crypto";

/**
 * Ephemeral GitHub App credentials for an e2e run.
 *
 * The server's `oauth.githubApp` config block is all-or-nothing — setting one
 * env var without the others tips the boot guard into the "half-configured"
 * error path (see `packages/server/src/boot-guards.ts`). So even tests that
 * don't drive webhooks share the same bundle: a fresh RSA key pair, dummy
 * App / Client ids, plus a webhook secret the `github-mock` (M2) will use to
 * sign payloads the server validates.
 *
 * Nothing here ever talks to api.github.com — the github-mock proxies via
 * `FIRST_TREE_GITHUB_API_BASE_URL` (F3 from the M0 spike), so neither
 * the private key nor the App id need to correspond to a real GitHub App.
 */
export type GitHubAppFixture = {
  appId: string;
  clientId: string;
  clientSecret: string;
  privateKeyPem: string;
  publicKeyPem: string;
  webhookSecret: string;
  /** Env var bundle suitable for spawnServer's `extraEnv`. */
  toServerEnv: () => Record<string, string>;
};

export function makeGitHubAppFixture(): GitHubAppFixture {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // Server's boot guard requires PKCS#8 (`-----BEGIN PRIVATE KEY-----`) — the
  // legacy PKCS#1 (`-----BEGIN RSA PRIVATE KEY-----`) is rejected with a
  // helpful "expected `-----BEGIN PRIVATE KEY-----` header" error.
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const appId = String(1_000_000 + Math.floor(Math.random() * 1_000_000));
  const clientId = `Iv1.${randomBytes(8).toString("hex")}`;
  const clientSecret = randomBytes(20).toString("hex");
  const webhookSecret = randomBytes(32).toString("hex");

  return {
    appId,
    clientId,
    clientSecret,
    privateKeyPem,
    publicKeyPem,
    webhookSecret,
    toServerEnv: () => ({
      FIRST_TREE_GITHUB_APP_ID: appId,
      FIRST_TREE_GITHUB_APP_CLIENT_ID: clientId,
      FIRST_TREE_GITHUB_APP_CLIENT_SECRET: clientSecret,
      FIRST_TREE_GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET: webhookSecret,
    }),
  };
}
