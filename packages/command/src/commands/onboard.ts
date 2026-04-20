import { confirm, input, select } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { formatCheckReport, loadOnboardState, onboardCheck, onboardCreate, saveOnboardState } from "../core/onboard.js";
import { isInteractive } from "../core/prompt.js";

async function promptMissing(args: Record<string, unknown>): Promise<void> {
  // 1. Server URL
  if (!args.server) {
    try {
      const { resolveServerUrl } = await import("../core/bootstrap.js");
      resolveServerUrl();
    } catch {
      args.server = await input({ message: "Hub server URL:" });
      saveOnboardState(args);
    }
  }

  // 2. Require that the user has already run `first-tree-hub client connect`
  const { loadCredentials } = await import("../core/bootstrap.js");
  if (!loadCredentials()) {
    throw new Error("No saved credentials. Run `first-tree-hub client connect <server-url>` before onboarding.");
  }

  if (!args.id) {
    args.id = await input({ message: "Agent ID:" });
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

  if (args.type !== "human" && args.clientId === undefined) {
    args.clientId = await input({
      message: "Computer ID (Enter to leave unbound — first WS connect will claim it):",
    });
    if (!args.clientId) args.clientId = undefined;
    saveOnboardState(args);
  }

  if (!args.role) {
    const role = await input({ message: "Role (optional, Enter to skip):" });
    if (role) {
      args.role = role;
      saveOnboardState(args);
    }
  }

  if (!args.domains) {
    const domains = await input({ message: "Domains (comma-separated, optional, Enter to skip):" });
    if (domains) {
      args.domains = domains;
      saveOnboardState(args);
    }
  }

  if (!args.displayName) {
    const name = await input({ message: `Display name (Enter to use "${args.id as string}"):` });
    if (name) {
      args.displayName = name;
      saveOnboardState(args);
    }
  }

  if (!args.assistant && args.type === "human") {
    const wantAssistant = await confirm({ message: "Create a personal assistant?", default: false });
    if (wantAssistant) {
      args.assistant = await input({
        message: "Assistant ID:",
        default: `${args.id as string}-assistant`,
      });
      if (args.clientId === undefined) {
        const v = await input({
          message: "Computer ID for the assistant (Enter to leave unbound):",
        });
        args.clientId = v || undefined;
      }
      saveOnboardState(args);
    }
  }

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
    .description("Onboard a new agent to First Tree Hub")
    .option("--id <id>", "Agent ID")
    .option("--type <type>", "Agent type: human | personal_assistant | autonomous_agent")
    .option("--client-id <id>", "Computer to pin a non-human agent to")
    .option("--display-name <name>", "Display name (defaults to id)")
    .option("--role <role>", "Role description")
    .option("--domains <domains>", "Comma-separated domains")
    .option("--assistant <id>", "Also create a personal_assistant with this ID")
    .option("--delegate-mention <id>", "Set delegate_mention field")
    .option("--server <url>", "Hub server URL")
    .option("--feishu-bot-app-id <id>", "Feishu bot App ID")
    .option("--feishu-bot-app-secret <secret>", "Feishu bot App Secret")
    .option("--check", "Dry-run: show readiness checklist without executing")
    .action(async (options) => {
      try {
        const saved = loadOnboardState() ?? {};
        const args: Record<string, unknown> = {
          ...saved,
          ...(options.id && { id: options.id }),
          ...(options.type && { type: options.type }),
          ...(options.clientId && { clientId: options.clientId }),
          ...(options.displayName && { displayName: options.displayName }),
          ...(options.role && { role: options.role }),
          ...(options.domains && { domains: options.domains }),
          ...(options.assistant && { assistant: options.assistant }),
          ...(options.delegateMention && { delegateMention: options.delegateMention }),
          ...(options.server && { server: options.server }),
          ...(options.feishuBotAppId && { feishuBotAppId: options.feishuBotAppId }),
          ...(options.feishuBotAppSecret && { feishuBotAppSecret: options.feishuBotAppSecret }),
          check: options.check,
        };

        if (!args.feishuBotAppId && process.env.FEISHU_APP_ID) args.feishuBotAppId = process.env.FEISHU_APP_ID;
        if (!args.feishuBotAppSecret && process.env.FEISHU_APP_SECRET)
          args.feishuBotAppSecret = process.env.FEISHU_APP_SECRET;

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

        if (isInteractive()) {
          await promptMissing(args);
        }

        const items = await onboardCheck(args as Parameters<typeof onboardCheck>[0]);
        const hasErrors = items.some((i) => i.status === "missing_required" || i.status === "error");
        if (hasErrors) {
          const report = formatCheckReport(items);
          process.stderr.write(`\nOnboard Check: ${(args.id as string) ?? "(no id)"}\n\n${report}\n\n`);
          fail("MISSING_PARAMS", "Required parameters are missing. See checklist above.");
        }

        await onboardCreate(args as Parameters<typeof onboardCreate>[0]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (isInteractive()) {
          process.stderr.write(`\n\u274C ${msg}\n\n`);
          process.exit(1);
        }
        fail("ONBOARD_ERROR", msg);
      }
    });
}
