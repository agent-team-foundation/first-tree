export const CONTEXT_TREE_SETUP_PREVIEW_ROLES = ["admin", "member"] as const;

export type ContextTreeSetupPreviewRole = (typeof CONTEXT_TREE_SETUP_PREVIEW_ROLES)[number];

const INSTALL_COMMAND = "curl -fsSL https://download.first-tree.ai/releases/staging/install.sh | sh";
const FIXTURE_CODE_PATTERN = /^FT-PREVIEW-STAGING-(?:(?:ADMIN|MEMBER)|[A-Z0-9]+-(?:ADMIN|MEMBER))$/;

export type ContextTreeSetupPreviewQuery = {
  role: ContextTreeSetupPreviewRole;
  expired: boolean;
  controls: boolean;
  search: string;
  changed: boolean;
};

export type ContextTreeSetupPreviewModel = {
  code: string;
  command: string;
  prompt: string;
};

export function normalizeContextTreeSetupPreviewQuery(search = ""): ContextTreeSetupPreviewQuery {
  const params = new URLSearchParams(search);
  const before = params.toString();

  const requestedRoles = params.getAll("role");
  const hasExplicitRole = params.has("role");
  const role =
    requestedRoles.length === 1 && isContextTreeSetupPreviewRole(requestedRoles[0]) ? requestedRoles[0] : "admin";
  if (hasExplicitRole && (requestedRoles.length !== 1 || requestedRoles[0] !== role)) {
    params.delete("role");
    params.set("role", role);
  }

  const requestedCodes = params.getAll("code");
  const expired = requestedCodes.length === 1 && requestedCodes[0] === "expired";
  if (!expired && params.has("code")) params.delete("code");

  const requestedControls = params.getAll("controls");
  const controls = requestedControls.length === 1 && requestedControls[0] === "1";
  if (!controls && params.has("controls")) params.delete("controls");

  const normalizedSearch = params.toString();
  return {
    role,
    expired,
    controls,
    search: normalizedSearch,
    changed: normalizedSearch !== before,
  };
}

export function setupPreviewCode(role: ContextTreeSetupPreviewRole, version = 0): string {
  if (!Number.isInteger(version) || version < 0) {
    throw new TypeError("Fixture version must be a non-negative integer");
  }
  const suffix = role.toUpperCase();
  if (version === 0) return `FT-PREVIEW-STAGING-${suffix}`;
  return `FT-PREVIEW-STAGING-${version.toString(36).toUpperCase()}-${suffix}`;
}

export function setupPreviewBootstrapCommand(code: string): string {
  if (!FIXTURE_CODE_PATTERN.test(code)) {
    throw new TypeError("A valid staging preview fixture code is required");
  }
  return `${INSTALL_COMMAND}\n~/.local/bin/first-tree-staging login ${code}`;
}

export function setupPreviewPrompt(role: ContextTreeSetupPreviewRole, code: string): string {
  const command = setupPreviewBootstrapCommand(code);
  const fixtureNotice = "Preview note: this fixture code does not authenticate.";

  if (role === "admin") {
    return `Help me set up Context Tree for Gandy's team on First Tree.

Team: team_7F3K
${fixtureNotice}

First, run this exact staging bootstrap on my computer:
${command}

Then follow this exact Admin sequence:
1. Run tree init to initialize and bind the Context Tree.
2. Install or connect the First Tree GitHub App and grant it only the exact Context Tree repository.
3. The base bootstrap and ordinary setup must not create a First Tree Agent. Create a reviewer Agent only if automatic Review is enabled.
4. Invite the team.

Keep the rest of setup in this coding-agent session.`;
  }

  return `Connect this coding-agent session to Gandy's team on First Tree.

Team: team_7F3K
${fixtureNotice}

First, run this exact staging bootstrap on my computer:
${command}

Verify an exact read of the Team's shared Context Tree and report the snapshot read.`;
}

export function contextTreeSetupPreviewModel(
  role: ContextTreeSetupPreviewRole,
  version = 0,
): ContextTreeSetupPreviewModel {
  const code = setupPreviewCode(role, version);
  return {
    code,
    command: setupPreviewBootstrapCommand(code),
    prompt: setupPreviewPrompt(role, code),
  };
}

function isContextTreeSetupPreviewRole(value: string | undefined): value is ContextTreeSetupPreviewRole {
  return value === "admin" || value === "member";
}
