import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type GitlabDnsLookup,
  type GitlabEgressAllowlistEntry,
  GitlabEgressPolicyError,
  type GitlabPinnedDestination,
  resolveAuthorizedGitlabDestination,
} from "./gitlab-egress-policy.js";

/** Build a Git process environment with no ambient proxy or authentication path. */
export async function anonymousGitEnv(cacheRoot: string): Promise<NodeJS.ProcessEnv> {
  const isolatedHome = join(cacheRoot, ".anonymous-home");
  await mkdir(isolatedHome, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^(?:http|https|all|no)_proxy$/iu.test(key) ||
      /^git_(?:askpass|ssh|ssh_command|config_|ssl_|http_)/iu.test(key) ||
      key === "SSH_AUTH_SOCK"
    ) {
      delete env[key];
    }
  }
  return {
    ...env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
  };
}

/** Git config for anonymous, address-pinned HTTPS with redirect/auth isolation. */
export function gitlabAnonymousGitConfig(destination: GitlabPinnedDestination | null | undefined): string[] {
  if (!destination) throw new GitlabEgressPolicyError("origin_not_authorized");
  return [
    "http.followRedirects=false",
    "http.curloptResolve=",
    `http.${destination.origin}/.curloptResolve=${destination.curlResolve}`,
    "http.extraHeader=",
    "http.cookieFile=",
    "http.sslCert=",
    "http.sslKey=",
    "http.proxy=",
    "credential.helper=",
  ];
}

/** Recheck live binding/policy and require DNS to remain on the pinned answer set. */
export async function revalidateGitlabDestination(
  enabled: boolean,
  before: GitlabPinnedDestination | null | undefined,
  allowlist: readonly GitlabEgressAllowlistEntry[],
  lookup?: GitlabDnsLookup,
  executionGuard?: () => Promise<boolean>,
): Promise<void> {
  if (!enabled || !before) return;
  if (executionGuard && !(await executionGuard())) {
    throw new GitlabEgressPolicyError("origin_not_authorized");
  }
  const after = await resolveAuthorizedGitlabDestination(allowlist, before.origin, lookup);
  if (
    after.pinnedAddress !== before.pinnedAddress ||
    after.addresses.length !== before.addresses.length ||
    after.addresses.some((address, index) => address !== before.addresses[index])
  ) {
    throw new GitlabEgressPolicyError("address_not_authorized");
  }
}

/** Reject cached repositories whose local config could restore auth, redirects, or alternate egress. */
export async function assertAnonymousLocalConfigSafe(root: string): Promise<void> {
  const raw = await readFile(join(root, ".git", "config"), "utf8");
  if (
    /^\s*\[(?:credential|http|url|include(?:if)?)\b/imu.test(raw) ||
    /^\s*(?:extraheader|cookiefile|sslcert|sslkey|proxy|sshcommand|curloptresolve|followredirects)\s*=/imu.test(raw)
  ) {
    throw new GitlabEgressPolicyError("address_not_authorized");
  }
}

export class GitLabAnonymousAuthenticationRequiredError extends Error {
  constructor() {
    super("GitLab repository requires authentication for anonymous Cloud read.");
    this.name = "GitLabAnonymousAuthenticationRequiredError";
  }
}

function gitFailureText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const stderr =
    typeof (error as Error & { stderr?: unknown }).stderr === "string"
      ? (error as Error & { stderr: string }).stderr
      : "";
  return `${error.message}\n${stderr}`.toLowerCase();
}

export function isGitlabAnonymousAuthenticationFailure(error: unknown): boolean {
  if (error instanceof GitLabAnonymousAuthenticationRequiredError) return true;
  const text = gitFailureText(error);
  return (
    /requires authentication|authentication failed|authorization failed|http basic: access denied|access denied|permission denied/u.test(
      text,
    ) ||
    /could not read (?:username|password)|terminal prompts disabled/u.test(text) ||
    /\b(?:http|server) returned (?:401|403)\b/u.test(text)
  );
}

export function isGitlabRedirectFailure(error: unknown): boolean {
  return /\bredirect(?:ed|ion)?\b|returned (?:30[123678])\b/u.test(gitFailureText(error));
}
