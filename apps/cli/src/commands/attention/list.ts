import type { ListAttentionsQuery } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { listAttentions } from "../../core/attention/index.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface ListOptions {
  raisedByMe?: boolean;
  state?: string;
  fromAgent?: string;
  inChat?: string;
  limit?: string;
  agent?: string;
}

export function registerAttentionListCommand(parent: Command): void {
  parent
    .command("list")
    .description("List attentions visible to this agent (default: attentions targeting me)")
    .option("--raised-by-me", "Show attentions this agent raised, instead of those targeting it")
    .option("--state <state>", "open | closed | all (default: open)")
    .option("--from-agent <id>", "Filter to attentions raised by this origin agent id")
    .option("--in-chat <id>", "Filter to attentions anchored to this chat id")
    .option("-l, --limit <number>", "Max records to return (1-200)")
    .option("--agent <name>", "Agent name on the Hub (default: first configured on this client)")
    .action(async (options: ListOptions) => {
      try {
        const filter: Partial<ListAttentionsQuery> = {};

        if (options.state !== undefined) {
          if (options.state !== "open" && options.state !== "closed" && options.state !== "all") {
            fail("INVALID_STATE", `--state must be one of: open, closed, all (got "${options.state}").`, 2);
          }
          filter.state = options.state;
        }

        if (options.inChat !== undefined) {
          filter.chat = options.inChat;
        }

        // Default semantics: target=me (the calling agent). When --raised-by-me
        // is set we flip to agent=me; an explicit --from-agent overrides both
        // by pinning a specific origin agent id.
        const sdk = createSdk(options.agent);
        const meId = sdk.agentId;
        if (meId === undefined) {
          fail(
            "AGENT_REQUIRED",
            "Could not determine the calling agent. Pass --agent <name> or run inside an agent session.",
            2,
          );
        }
        if (options.fromAgent !== undefined) {
          filter.agent = options.fromAgent;
        } else if (options.raisedByMe === true) {
          filter.agent = meId;
        } else {
          filter.target = meId;
        }

        if (options.limit !== undefined) {
          const parsed = Number.parseInt(options.limit, 10);
          if (Number.isNaN(parsed) || parsed < 1 || parsed > 200) {
            fail("INVALID_LIMIT", "Limit must be between 1 and 200.", 2);
          }
          filter.limit = parsed;
        }

        const records = await listAttentions(sdk, filter);
        success(records);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
