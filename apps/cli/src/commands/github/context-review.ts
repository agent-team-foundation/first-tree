import { readFile, stat } from "node:fs/promises";
import { CONTEXT_REVIEW_BODY_MAX_BYTES, contextReviewSubmitRequestSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";

interface SubmitOptions {
  agent?: string;
  run: string;
  head: string;
  event: string;
  bodyFile: string;
}

export function registerGithubContextReviewCommand(github: Command): void {
  const contextReview = github
    .command("context-review")
    .description("Submit a server-authored Context Reviewer outcome for GitHub App publication.");

  contextReview
    .command("submit")
    .requiredOption("--run <runId>", "Server-authored Context Reviewer run id")
    .requiredOption("--head <oid>", "Exact inspected 40-character PR head OID")
    .requiredOption("--event <event>", "APPROVE, REQUEST_CHANGES, or COMMENT")
    .requiredOption("--body-file <path>", "Review body file (`-` reads stdin)")
    .option("--agent <name>", "Local agent name")
    .action(async (options: SubmitOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID?.trim();
        if (!chatId) {
          fail("NO_CHAT_CONTEXT", "Context review submission requires an active FIRST_TREE_CHAT_ID session.", 2);
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

        const body = await readReviewBody(options.bodyFile);
        const parsed = contextReviewSubmitRequestSchema.safeParse({
          reviewedHead: options.head,
          event: options.event,
          body,
        });
        if (!parsed.success) {
          fail("INVALID_CONTEXT_REVIEW", parsed.error.issues.map((issue) => issue.message).join("; "), 2);
        }

        const result = await createSdk(options.agent).submitContextReview(chatId, options.run, parsed.data);
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
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
