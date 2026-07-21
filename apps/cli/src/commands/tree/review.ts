import { readFile, stat } from "node:fs/promises";
import {
  CONTEXT_REVIEW_BODY_MAX_BYTES,
  contextReviewAuthorityRequestSchema,
  contextReviewSubmitRequestSchema,
} from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import type { CommandContext, SubcommandModule } from "../types.js";

type TreeReviewOptions = {
  run?: string;
  head?: string;
  event?: string;
  bodyFile?: string;
  check?: boolean;
};

function configureTreeReviewCommand(command: Command): void {
  command
    .requiredOption("--run <runId>", "Server-authored Context Reviewer run id")
    .requiredOption("--head <oid>", "Exact inspected 40-character PR head OID")
    .option("--check", "Verify live run authority without publishing")
    .option("--event <event>", "APPROVE, REQUEST_CHANGES, or COMMENT")
    .option("--body-file <path>", "Review body file (`-` reads stdin)");
}

export async function runTreeReviewCommand(context: CommandContext): Promise<void> {
  const options = context.command.opts<TreeReviewOptions>();
  try {
    const chatId = process.env.FIRST_TREE_CHAT_ID?.trim();
    if (!chatId) {
      fail("NO_CHAT_CONTEXT", "Context review submission requires an active FIRST_TREE_CHAT_ID session.", 2);
    }
    const agentId = process.env.FIRST_TREE_AGENT_ID?.trim();
    if (!agentId) {
      fail("NO_AGENT_CONTEXT", "Context review submission requires an active FIRST_TREE_AGENT_ID session.", 2);
    }
    const runtimeTokenFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE?.trim();
    if (!runtimeTokenFile) {
      fail("NO_RUNTIME_SESSION", "Context review submission requires the active agent runtime session token.", 3);
    }
    const runtimeToken = await readFile(runtimeTokenFile, "utf8").catch(() => "");
    if (!runtimeToken.trim()) {
      fail(
        "NO_RUNTIME_SESSION",
        "Context review submission requires a readable active agent runtime session token.",
        3,
      );
    }

    const sdk = createSdk();
    if (options.check) {
      if (options.event || options.bodyFile) {
        fail("INVALID_CONTEXT_REVIEW", "--check cannot be combined with --event or --body-file.", 2);
      }
      const parsed = contextReviewAuthorityRequestSchema.safeParse({ reviewedHead: options.head });
      if (!parsed.success) {
        fail("INVALID_CONTEXT_REVIEW", parsed.error.issues.map((issue) => issue.message).join("; "), 2);
      }
      success(await sdk.inspectContextReviewAuthority(chatId, options.run ?? "", parsed.data));
      return;
    }
    if (!options.event || !options.bodyFile) {
      fail("INVALID_CONTEXT_REVIEW", "Publication requires both --event and --body-file.", 2);
    }
    const body = await readReviewBody(options.bodyFile);
    const parsed = contextReviewSubmitRequestSchema.safeParse({
      reviewedHead: options.head,
      event: options.event,
      body,
    });
    if (!parsed.success) {
      fail("INVALID_CONTEXT_REVIEW", parsed.error.issues.map((issue) => issue.message).join("; "), 2);
    }

    const result = await sdk.submitContextReview(chatId, options.run ?? "", parsed.data);
    success(result);
  } catch (error) {
    handleSdkError(error);
  }
}

async function readReviewBody(path: string): Promise<string> {
  if (path === "-") {
    if (process.stdin.isTTY) {
      fail("NO_REVIEW_BODY", "--body-file - requires review body content on stdin.", 2);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > CONTEXT_REVIEW_BODY_MAX_BYTES) {
        fail("REVIEW_BODY_TOO_LARGE", `Review body exceeds ${CONTEXT_REVIEW_BODY_MAX_BYTES} bytes.`, 2);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    fail("REVIEW_BODY_FILE_INVALID", `--body-file must name a readable regular file: ${path}`, 2);
  }
  if (info.size > CONTEXT_REVIEW_BODY_MAX_BYTES) {
    fail("REVIEW_BODY_TOO_LARGE", `Review body exceeds ${CONTEXT_REVIEW_BODY_MAX_BYTES} bytes.`, 2);
  }
  return readFile(path, "utf8").catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    return fail("REVIEW_BODY_FILE_UNREADABLE", `Unable to read --body-file: ${detail}`, 2);
  });
}

export const treeReviewCommand: SubcommandModule = {
  name: "review",
  alias: "",
  summary: "",
  description: "Publish the current trusted Context Reviewer run through the GitHub App.",
  configure: configureTreeReviewCommand,
  action: runTreeReviewCommand,
};
