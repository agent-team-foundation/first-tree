import {
  TREE_WRITE_ERROR_CODES,
  type TreeWriteTaskResult,
  type TreeWriteTaskStart,
  treeWriteTaskResultSchema,
} from "@agent-team-foundation/first-tree-hub-shared";
import { buildAgentEnv } from "./agent-io.js";
import type {
  AgentHandler,
  AgentIdentity,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "./handler.js";

type TreeWriteBackgroundRunnerConfig = {
  agent: AgentIdentity;
  handlerFactory: HandlerFactory;
  handlerConfig: HandlerConfig;
  sdk: SessionContext["sdk"];
  log: SessionContext["log"];
  onHeartbeat: (taskId: string, attemptCount: number) => void;
  onResult: (result: TreeWriteTaskResult) => void;
};

const TREE_WRITE_RUNNER_TIMEOUT_MS = 30 * 60_000;

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseTreeWriteTaskResultForAttempt(taskId: string, attemptCount: number, text: string): TreeWriteTaskResult {
  const raw = stripJsonCodeFence(text);
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  return treeWriteTaskResultSchema.parse({
    type: "task:tree_write:result",
    taskId,
    attemptCount,
    ...parsed,
  });
}

function treeWriteFailure(
  taskId: string,
  attemptCount: number,
  code: keyof typeof TREE_WRITE_ERROR_CODES,
  message: string,
): TreeWriteTaskResult {
  return {
    type: "task:tree_write:result",
    taskId,
    attemptCount,
    kind: "failed",
    error: { code: TREE_WRITE_ERROR_CODES[code], message },
  };
}

export class TreeWriteBackgroundRunner {
  private readonly queue: TreeWriteTaskStart[] = [];
  private runningTaskId: string | null = null;
  private currentHandler: AgentHandler | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly config: TreeWriteBackgroundRunnerConfig) {}

  enqueue(task: TreeWriteTaskStart): void {
    if (this.runningTaskId === task.taskId) return;
    if (this.queue.some((entry) => entry.taskId === task.taskId)) return;
    this.queue.push(task);
    this.drain();
  }

  async shutdown(): Promise<void> {
    this.queue.length = 0;
    this.stopHeartbeat();
    if (!this.currentHandler) return;
    try {
      await this.currentHandler.shutdown();
    } catch {
      // best-effort shutdown
    } finally {
      this.currentHandler = null;
      this.runningTaskId = null;
    }
  }

  private drain(): void {
    if (this.runningTaskId) return;
    const next = this.queue.shift();
    if (!next) return;
    void this.run(next);
  }

  private async run(task: TreeWriteTaskStart): Promise<void> {
    this.runningTaskId = task.taskId;
    this.startHeartbeat(task.taskId, task.attemptCount);
    let finished = false;
    let resolveResult: ((result: TreeWriteTaskResult) => void) | null = null;
    const resultPromise = new Promise<TreeWriteTaskResult>((resolve) => {
      resolveResult = resolve;
    });

    const finish = (result: TreeWriteTaskResult): void => {
      if (finished) return;
      finished = true;
      this.config.onResult(result);
      resolveResult?.(result);
    };

    const sessionCtx: SessionContext = {
      agent: this.config.agent,
      sdk: this.config.sdk,
      log: this.config.log,
      chatId: task.execChatId,
      touch: () => {},
      setRuntimeState: () => {},
      emitEvent: () => {},
      forwardResult: async (text: string) => {
        try {
          finish(parseTreeWriteTaskResultForAttempt(task.taskId, task.attemptCount, text));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          finish(treeWriteFailure(task.taskId, task.attemptCount, "INVALID_RESULT_PAYLOAD", message));
        }
      },
      buildAgentEnv: (parentEnv) =>
        buildAgentEnv(parentEnv, { sdk: this.config.sdk, agent: this.config.agent, chatId: task.execChatId }),
      formatInboundContent: async (message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      resolveSenderLabel: async (senderId) => senderId,
    };

    const syntheticMessage: SessionMessage = {
      id: task.taskId,
      chatId: task.execChatId,
      senderId: "",
      format: "text",
      content: task.prompt,
      metadata: {},
    };

    try {
      const handler = this.config.handlerFactory(this.config.handlerConfig);
      this.currentHandler = handler;
      await handler.start(syntheticMessage, sessionCtx);
      const result = await Promise.race([
        resultPromise,
        new Promise<TreeWriteTaskResult>((resolve) => {
          setTimeout(() => {
            resolve(
              treeWriteFailure(
                task.taskId,
                task.attemptCount,
                "TREE_WRITE_TOOL_ERROR",
                "tree-write background task timed out before producing a terminal result",
              ),
            );
          }, TREE_WRITE_RUNNER_TIMEOUT_MS);
        }),
      ]);
      if (!finished) finish(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish(treeWriteFailure(task.taskId, task.attemptCount, "TREE_WRITE_TOOL_ERROR", message));
    } finally {
      this.stopHeartbeat();
      if (this.currentHandler) {
        try {
          await this.currentHandler.shutdown();
        } catch {
          // best-effort cleanup
        }
      }
      this.currentHandler = null;
      this.runningTaskId = null;
      this.drain();
    }
  }

  private startHeartbeat(taskId: string, attemptCount: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.config.onHeartbeat(taskId, attemptCount);
    }, 60_000);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
