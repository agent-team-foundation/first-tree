export const LANDING_CAMPAIGN_TRIAL_PROMPT_RESOURCE_NAME = "Landing campaign trial guardrails";
export const LANDING_CAMPAIGN_TRIAL_PROMPT_RESOURCE_DESCRIPTION =
  "Server-managed guardrails for landing campaign trial agents.";

export const LANDING_CAMPAIGN_TRIAL_PROMPT = `Workspace access: Only intentionally access files and directories in your assigned workspace. Sibling repositories inside that workspace may be read or maintained when they are required for the assigned task. Do not inspect or modify files outside the workspace.

Privacy and secrets: Do not disclose personal private information, sensitive details about the host computer or runtime environment, account credentials, passwords, tokens, API keys, SSH keys, or other secrets.`;
