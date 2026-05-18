import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PACKAGE_E2E_ROOT } from "./env.js";

export const HANDLE_PATH = resolve(PACKAGE_E2E_ROOT, ".e2e-runs", "current.json");

export type ProvisionedCredentialsHandle = {
  userId: string;
  organizationId: string;
  memberId: string;
  humanAgentId: string;
  /** Lowercase `agents.name` of the human agent — usable as a mention/assignee login. */
  humanAgentName: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
};

export type CurrentRunHandle = {
  runId: string;
  serverBaseUrl: string;
  databaseUrl: string;
  clientHome: string;
  jwtSecret: string;
  /** Webhook HMAC secret the server was booted with — feed to github-mock. */
  githubWebhookSecret: string;
  /** Populated only when globalSetup ran with `withClient: true`. */
  credentials: ProvisionedCredentialsHandle | null;
};

export function readCurrentHandle(): CurrentRunHandle {
  return JSON.parse(readFileSync(HANDLE_PATH, "utf8")) as CurrentRunHandle;
}

export function readCredentialsOrThrow(handle: CurrentRunHandle): ProvisionedCredentialsHandle {
  if (!handle.credentials) {
    throw new Error(
      "E2E run was started without `withClient: true`; this test requires provisioned credentials. " +
        "Toggle globalSetup or pass E2E_WITH_CLIENT=1.",
    );
  }
  return handle.credentials;
}
