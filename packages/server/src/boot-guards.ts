import type { Config } from "./config.js";
import { assertContentSecurityPolicySize } from "./security-headers.js";
import { assertEncryptionKeyValid } from "./services/crypto.js";
import { assertWebSecurityContract } from "./web-security.js";

/**
 * Boot-time configuration sanity checks. Called from `buildApp` (and thus
 * from `packages/server/src/index.ts`'s bootstrap path).
 *
 * Throws on misconfiguration; never returns a value.
 */
export function assertBootConfigValid(config: Config): void {
  assertSecretsValid(config);
  assertProductionRequiresPublicUrl(config);
  assertGithubAppConfigComplete(config);
  assertWebSecurityContract(config);
  assertContentSecurityPolicySize(config);
}

function assertSecretsValid(config: Config): void {
  const missing = [
    config.secrets.jwtSecret.trim().length === 0 ? "FIRST_TREE_JWT_SECRET" : undefined,
    config.secrets.encryptionKey.trim().length === 0 ? "FIRST_TREE_ENCRYPTION_KEY" : undefined,
  ].filter((value): value is string => value !== undefined);

  if (missing.length > 0) {
    throw new Error(`Missing required server secret env vars: ${missing.join(", ")}.`);
  }

  try {
    assertEncryptionKeyValid(config.secrets.encryptionKey);
  } catch {
    throw new Error("FIRST_TREE_ENCRYPTION_KEY must be 32 bytes, encoded as hex (64 chars) or base64url (43 chars).");
  }
}

function assertProductionRequiresPublicUrl(config: Config): void {
  // `server.publicUrl` is what short connect codes store as their issuer and
  // what OAuth callback URLs are built off of. Booting prod without it means
  // code exchange and OAuth would trust whatever the inbound proxy injected
  // via Host headers (forgery risk). Fail closed.
  if (process.env.NODE_ENV === "production" && !config.server.publicUrl) {
    throw new Error("FIRST_TREE_PUBLIC_URL is required in production — set the public-facing First Tree URL.");
  }
}

function assertGithubAppConfigComplete(config: Config): void {
  // Half-configured guard for the GitHub App block. All five fields ride
  // together — App user-OAuth uses clientId/clientSecret, App JWT uses
  // appId/privateKeyPem, webhook endpoint verifies signatures with
  // webhookSecret. A partially-set block almost always means the
  // operator copied the env recipe but missed one var; fail loud rather
  // than serve a half-working install flow OR — worse — accept a blank
  // webhookSecret that turns HMAC-SHA256 into a forgeable hash
  // (codex P1-8: any actor who knows the SHA-256 of the request body
  // with empty key could spoof webhooks).
  //
  // The Zod schema on `oauth.githubApp.*` enforces `.min(1)` so blank
  // env values never make it this far — but this guard is the
  // belt-and-braces defense in case the schema is ever loosened or a
  // future field is added without the same constraint.
  const ghApp = config.oauth?.githubApp;
  if (!ghApp) return;

  const required: Record<string, string | undefined> = {
    FIRST_TREE_GITHUB_APP_ID: ghApp.appId,
    FIRST_TREE_GITHUB_APP_CLIENT_ID: ghApp.clientId,
    FIRST_TREE_GITHUB_APP_CLIENT_SECRET: ghApp.clientSecret,
    FIRST_TREE_GITHUB_APP_PRIVATE_KEY: ghApp.privateKeyPem,
    FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET: ghApp.webhookSecret,
  };
  const missing = Object.entries(required)
    .filter(([, v]) => !v || v.trim().length === 0)
    .map(([k]) => k);
  // The "0 < missing < all" check catches the half-configured case
  // (some set, some not). All-empty is a no-op (block resolves to
  // undefined via the `optional({...})` semantics, but we double-check
  // here because `field(z.string().min(1))` will surface a Zod error
  // BEFORE this code runs anyway — the trim-check above is the
  // belt-and-braces backstop).
  if (missing.length > 0 && missing.length < Object.keys(required).length) {
    throw new Error(`GitHub App is half-configured — missing env vars: ${missing.join(", ")}. Set all five or none.`);
  }
  if (missing.length === Object.keys(required).length) {
    // All empty post-trim — treat as "not configured" by failing the
    // present-but-empty block. Operators who want the App disabled
    // should leave the env vars unset (which makes `oauth.githubApp`
    // undefined entirely); a present-but-empty block is ambiguous and
    // suggests env-file copy mistakes.
    throw new Error(
      "GitHub App env block is present but every value is empty — unset the FIRST_TREE_GITHUB_APP_* vars to disable App sign-in.",
    );
  }
  // Belt-and-braces: a real PKCS#8 PEM starts with this header. Catches
  // the common operator mistake of pasting only the body or leaving in
  // literal `\n` sequences instead of newlines. Cheap to check at boot.
  if (ghApp.privateKeyPem && !ghApp.privateKeyPem.includes("-----BEGIN PRIVATE KEY-----")) {
    throw new Error(
      "FIRST_TREE_GITHUB_APP_PRIVATE_KEY does not look like a PKCS#8 PEM — expected `-----BEGIN PRIVATE KEY-----` header. " +
        "If the value came from a single-line env file, replace literal `\\n` with real newlines.",
    );
  }
}
