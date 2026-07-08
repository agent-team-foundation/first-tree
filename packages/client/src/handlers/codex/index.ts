import { isLandingCampaignTrialAgentMetadata } from "@first-tree/shared";
import type { AgentHandler, HandlerFactory, SessionContext } from "../../runtime/handler.js";
import { CodexAppServerStartupError, createCodexAppServerHandler } from "./app-server/index.js";
import { createCodexSdkHandler } from "./sdk.js";

export {
  appendGitStatusDeltaRefs,
  buildCodexAgentBriefing,
  buildCodexThreadOptions,
  collectCodexFileChangePaths,
  computePerTurnUsageDelta,
  createCodexSdkHandler,
  isTransientCodexErrorMessage,
  toolFileRefsForTerminalCodexTool,
  toolFileRefsFromCodexFileChange,
} from "./sdk.js";

type CodexHandlerEngine = "app-server" | "sdk" | "auto";

function codexHandlerEngineFromEnv(env: NodeJS.ProcessEnv = process.env): CodexHandlerEngine {
  const raw = env.FIRST_TREE_CODEX_HANDLER_ENGINE?.trim().toLowerCase();
  if (raw === "app-server" || raw === "sdk" || raw === "auto") return raw;
  if (env.NODE_ENV === "test" || env.VITEST) return "sdk";
  return "auto";
}

function readCodexHandlerEngine(value: unknown): CodexHandlerEngine | null {
  if (value === "app-server" || value === "sdk" || value === "auto") return value;
  return null;
}

function assertCodexWorkspaceOnlySupported(ctx: SessionContext, engine: CodexHandlerEngine): void {
  if (!isLandingCampaignTrialAgentMetadata(ctx.agent.metadata)) return;
  if (engine === "sdk") {
    throw new Error("Landing campaign Codex trials require the app-server workspace-only runtime.");
  }
}

export const createCodexHandler: HandlerFactory = (config) => {
  const engine = readCodexHandlerEngine(config.codexHandlerEngine) ?? codexHandlerEngineFromEnv();
  if (engine === "sdk") {
    const sdkHandler = createCodexSdkHandler(config);
    return {
      start(message, ctx, token) {
        assertCodexWorkspaceOnlySupported(ctx, "sdk");
        return sdkHandler.start(message, ctx, token);
      },
      resume(message, sessionId, ctx, token) {
        assertCodexWorkspaceOnlySupported(ctx, "sdk");
        return sdkHandler.resume(message, sessionId, ctx, token);
      },
      inject(message, token) {
        return sdkHandler.inject(message, token);
      },
      suspend() {
        return sdkHandler.suspend();
      },
      shutdown(reason?: string) {
        return sdkHandler.shutdown(reason);
      },
    } satisfies AgentHandler;
  }
  if (engine === "app-server") return createCodexAppServerHandler(config);

  let active: AgentHandler = createCodexAppServerHandler(config);
  let usingFallback = false;

  function switchToSdk(): AgentHandler {
    usingFallback = true;
    active = createCodexSdkHandler(config);
    return active;
  }

  async function closeAppServerBeforeFallback(ctx: SessionContext, err: CodexAppServerStartupError): Promise<void> {
    const appServerHandler = active;
    try {
      await appServerHandler.shutdown();
    } catch (shutdownErr) {
      ctx.log(
        `codex app-server shutdown before fallback failed after ${err.stage}: ${
          shutdownErr instanceof Error ? shutdownErr.message : String(shutdownErr)
        }`,
      );
    }
  }

  return {
    async start(message, ctx, token) {
      try {
        return await active.start(message, ctx, token);
      } catch (err) {
        if (usingFallback || !(err instanceof CodexAppServerStartupError)) throw err;
        if (isLandingCampaignTrialAgentMetadata(ctx.agent.metadata)) throw err;
        await closeAppServerBeforeFallback(ctx, err);
        ctx.log(`${err.message}; falling back to @openai/codex-sdk handler`);
        return switchToSdk().start(message, ctx, token);
      }
    },

    async resume(message, sessionId, ctx, token) {
      try {
        return await active.resume(message, sessionId, ctx, token);
      } catch (err) {
        if (usingFallback || !(err instanceof CodexAppServerStartupError)) throw err;
        if (isLandingCampaignTrialAgentMetadata(ctx.agent.metadata)) throw err;
        await closeAppServerBeforeFallback(ctx, err);
        ctx.log(`${err.message}; falling back to @openai/codex-sdk handler`);
        return switchToSdk().resume(message, sessionId, ctx, token);
      }
    },

    inject(message, token) {
      return active.inject(message, token);
    },

    suspend() {
      return active.suspend();
    },

    shutdown(reason?: string) {
      return active.shutdown(reason);
    },
  } satisfies AgentHandler;
};
