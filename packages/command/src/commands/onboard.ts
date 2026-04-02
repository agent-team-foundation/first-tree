import { confirm, input, select } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail, success } from "../cli/output.js";
import {
  formatCheckReport,
  loadOnboardState,
  onboardCheck,
  onboardContinue,
  onboardCreate,
  saveOnboardState,
} from "../core/onboard.js";
import { isInteractive } from "../core/prompt.js";

async function promptMissing(args: Record<string, unknown>): Promise<void> {
  // Get GitHub username for defaults
  let ghUsername: string | null = null;
  try {
    const { getGitHubUsername } = await import("../core/bootstrap.js");
    ghUsername = getGitHubUsername();
  } catch {
    // gh not available, no defaults
  }

  if (!args.id) {
    args.id = await input({
      message: "Member ID (directory name):",
      default: ghUsername ?? undefined,
    });
    saveOnboardState(args);
  }

  if (!args.type) {
    args.type = await select({
      message: "Agent type:",
      choices: [
        { name: "human", value: "human" },
        { name: "personal_assistant", value: "personal_assistant" },
        { name: "autonomous_agent", value: "autonomous_agent" },
      ],
    });
    saveOnboardState(args);
  }

  if (!args.role) {
    args.role = await input({ message: "Role:" });
    saveOnboardState(args);
  }

  if (!args.domains) {
    args.domains = await input({ message: "Domains (comma-separated):" });
    saveOnboardState(args);
  }

  if (!args.displayName) {
    const name = await input({ message: `Display name (Enter to use "${args.id as string}"):` });
    if (name) {
      args.displayName = name;
      saveOnboardState(args);
    }
  }

  // Only human agents can have a personal assistant
  if (!args.assistant && args.type === "human") {
    const wantAssistant = await confirm({ message: "Create a personal assistant?", default: false });
    if (wantAssistant) {
      args.assistant = await input({
        message: "Assistant ID:",
        default: `${args.id as string}-assistant`,
      });
      saveOnboardState(args);
    }
  }

  if (!args.server) {
    try {
      const { resolveServerUrl } = await import("../core/bootstrap.js");
      resolveServerUrl();
    } catch {
      args.server = await input({ message: "Hub server URL:" });
      saveOnboardState(args);
    }
  }

  // Feishu bot binding is relevant for non-human agents, or human with assistant (bot binds to assistant)
  if (!args.feishuBotAppId && (args.type !== "human" || args.assistant)) {
    const wantFeishu = await confirm({ message: "Bind Feishu bot?", default: false });
    if (wantFeishu) {
      args.feishuBotAppId = await input({ message: "Feishu App ID:" });
      args.feishuBotAppSecret = await input({ message: "Feishu App Secret:" });
      saveOnboardState(args);
    }
  }
}

export function registerOnboardCommand(program: Command): void {
  program
    .command("onboard")
    .description("Onboard a new member to First Tree Hub (end-to-end)")
    .option("--id <id>", "Member ID (directory name)")
    .option("--type <type>", "Agent type: human | personal_assistant | autonomous_agent")
    .option("--display-name <name>", "Display name (defaults to id)")
    .option("--role <role>", "Role description")
    .option("--domains <domains>", "Comma-separated domains")
    .option("--assistant <id>", "Also create a personal_assistant with this ID")
    .option("--delegate-mention <id>", "Set delegate_mention field")
    .option("--server <url>", "Hub server URL")
    .option("--feishu-bot-app-id <id>", "Feishu bot App ID")
    .option("--feishu-bot-app-secret <secret>", "Feishu bot App Secret")
    .option("--check", "Dry-run: show readiness checklist without executing")
    .option("--continue", "Resume after PR merge (Phase 2)")
    .action(async (options) => {
      try {
        // Load saved state as defaults, then override with CLI args
        const saved = loadOnboardState() ?? {};
        const args: Record<string, unknown> = {
          ...saved,
          ...(options.id && { id: options.id }),
          ...(options.type && { type: options.type }),
          ...(options.displayName && { displayName: options.displayName }),
          ...(options.role && { role: options.role }),
          ...(options.domains && { domains: options.domains }),
          ...(options.assistant && { assistant: options.assistant }),
          ...(options.delegateMention && { delegateMention: options.delegateMention }),
          ...(options.server && { server: options.server }),
          ...(options.feishuBotAppId && { feishuBotAppId: options.feishuBotAppId }),
          ...(options.feishuBotAppSecret && { feishuBotAppSecret: options.feishuBotAppSecret }),
          check: options.check,
          continue: options.continue,
        };

        // Apply env var defaults
        if (!args.feishuBotAppId && process.env.FEISHU_APP_ID) args.feishuBotAppId = process.env.FEISHU_APP_ID;
        if (!args.feishuBotAppSecret && process.env.FEISHU_APP_SECRET)
          args.feishuBotAppSecret = process.env.FEISHU_APP_SECRET;

        if (args.continue) {
          await onboardContinue(args as Parameters<typeof onboardContinue>[0]);
          return;
        }

        if (args.check) {
          const items = await onboardCheck(args as Parameters<typeof onboardCheck>[0]);
          const report = formatCheckReport(items);
          process.stderr.write(`\nOnboard Check: ${(args.id as string) ?? "(no id)"}\n\n${report}\n\n`);
          const hasErrors = items.some((i) => i.status === "missing_required" || i.status === "error");
          if (hasErrors) {
            process.exit(1);
          }
          return;
        }

        // Interactive mode: prompt for missing required params
        if (isInteractive()) {
          await promptMissing(args);
        }

        // Validate — show full checklist on failure
        const items = await onboardCheck(args as Parameters<typeof onboardCheck>[0]);
        const hasErrors = items.some((i) => i.status === "missing_required" || i.status === "error");
        if (hasErrors) {
          const report = formatCheckReport(items);
          process.stderr.write(`\nOnboard Check: ${(args.id as string) ?? "(no id)"}\n\n${report}\n\n`);
          fail("MISSING_PARAMS", "Required parameters are missing. See checklist above.");
        }

        // Execute Phase 1
        const result = await onboardCreate(args as Parameters<typeof onboardCreate>[0]);
        process.stderr.write(`\nPR created: ${result.prUrl}\n`);
        process.stderr.write("Review and merge the PR, then run:\n");
        process.stderr.write("  first-tree-hub onboard --continue\n\n");
        success({ phase: "create", prUrl: result.prUrl });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isInteractive()) {
          process.stderr.write(`\n❌ ${msg}\n\n`);
          process.exit(1);
        }
        fail("ONBOARD_ERROR", msg);
      }
    });
}
