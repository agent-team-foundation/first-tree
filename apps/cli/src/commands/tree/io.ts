import { agentContextTreeIoQuerySchema } from "@first-tree/shared";
import type { Command } from "commander";
import { isJsonMode, print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type TreeIoOptions = {
  agent?: string;
  chat?: string;
  action?: string;
  since?: string;
  until?: string;
  limit?: string;
  cursor?: string;
  all?: boolean;
};

/** Hard stop on `--all` so one command can never walk an unbounded feed. */
const MAX_ALL_PAGES = 50;

function configureTreeIoCommand(command: Command): void {
  command
    .option("--agent <name>", "local agent whose IO feed to read (defaults to FIRST_TREE_AGENT_ID)")
    .option("--chat <chat-id>", "restrict to one Chat")
    .option("--action <action>", "restrict to `read` or `write`")
    .option("--since <rfc3339>", "only events at or after this timestamp")
    .option("--until <rfc3339>", "only events at or before this timestamp")
    .option("--limit <n>", "page size (1-200, default 50)")
    .option("--cursor <cursor>", "continue from a previous page")
    .option("--all", "follow pagination and emit every page (bounded)");
}

export async function runTreeIoCommand(context: CommandContext): Promise<void> {
  const options = context.command.opts<TreeIoOptions>();
  const parsed = agentContextTreeIoQuerySchema.safeParse({
    ...(options.chat ? { chatId: options.chat } : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(options.since ? { since: options.since } : {}),
    ...(options.until ? { until: options.until } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Invalid option: ${issue ? `${issue.path.join(".")} ${issue.message}` : "bad request"}`);
  }

  // The feed is a Class D route: it needs `X-Agent-Id` plus this agent's
  // runtime-session proof, which only the agent-scoped SDK attaches.
  const sdk = createSdk(options.agent);
  const items: unknown[] = [];
  let cursor = parsed.data.cursor;
  let pages = 0;
  let truncated = false;

  try {
    do {
      const page = await sdk.listAgentContextTreeIo({ ...parsed.data, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (options.all && cursor && pages >= MAX_ALL_PAGES) {
        truncated = true;
        break;
      }
    } while (options.all && cursor);
  } catch (error) {
    handleSdkError(error);
  }

  if (context.options.json || isJsonMode()) {
    print.result({
      items,
      nextCursor: cursor ?? null,
      ...(truncated ? { truncated: true } : {}),
    });
    return;
  }

  if (items.length === 0) {
    print.line("No Context Tree IO events for this agent in the requested range.");
    return;
  }
  for (const item of items as Array<{
    createdAt: string;
    action: string;
    targetKind: string;
    targetPath: string;
    source: string;
  }>) {
    print.line(
      `${item.createdAt}  ${item.action.padEnd(5)}  ${item.targetKind.padEnd(9)}  ${item.targetPath}  (${item.source})`,
    );
  }
  if (cursor) print.line(`\nMore results — continue with --cursor ${cursor}`);
  if (truncated) print.line(`Stopped after ${MAX_ALL_PAGES} pages; rerun with --cursor to continue.`);
}

export const treeIoCommand: SubcommandModule = {
  name: "io",
  alias: "",
  summary: "",
  description: "List this agent's own Context Tree read/write events.",
  configure: configureTreeIoCommand,
  action: runTreeIoCommand,
};
