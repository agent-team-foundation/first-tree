import type { Command } from "commander";
import {
  assertContextMutationCanStart,
  withAccountStateMutationLockAsync,
} from "../../core/context-integration/account-state-guard.js";
import { ContextPluginReloadRequiredError } from "../../core/context-integration/adapter-observation.js";
import { inspectContextClientPreflight } from "../../core/context-integration/client-preflight.js";
import { resolveContextRoute } from "../../core/context-integration/context-route.js";
import { print } from "../../core/output.js";
import { createMemberSdk } from "../_shared/member.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { parseContextProvider } from "./shared.js";

type RouteOptions = {
  provider?: string;
  projectRoot?: string;
  pathless?: boolean;
  sessionCandidate?: string;
};

function configure(command: Command): void {
  command
    .requiredOption("--provider <provider>", "provider activation owner")
    .option("--project-root <directory>", "immutable handoff project root")
    .option("--pathless", "immutable pathless handoff project")
    .option("--session-candidate <receipt>", "opaque session-only candidate receipt from the verified handoff");
}

export async function runContextRoute(context: CommandContext): Promise<void> {
  const options = context.command.opts<RouteOptions>();
  const provider = parseContextProvider(options.provider ?? "");
  const project = inspectContextClientPreflight(provider, {
    projectRoot: options.projectRoot,
    pathless: options.pathless,
  }).project;
  const sdk = createMemberSdk();
  try {
    const result = await withAccountStateMutationLockAsync(async () => {
      assertContextMutationCanStart();
      return resolveContextRoute(
        {
          validateMemberContextRouteCandidates(request, callOptions): Promise<unknown> {
            return sdk.validateMemberContextRouteCandidates(request, callOptions);
          },
          validateMemberContextSessionCandidate(request, callOptions): Promise<unknown> {
            return sdk.validateMemberContextSessionCandidate(request, callOptions);
          },
          validateMemberContextActivation(teamId, request, callOptions): Promise<unknown> {
            return sdk.validateMemberContextActivation(teamId, request, callOptions);
          },
          getMemberContextTreeSetting(teamId, callOptions): Promise<unknown> {
            return sdk.getMemberContextTreeSetting(teamId, callOptions);
          },
        },
        {
          provider,
          project,
          ...(options.sessionCandidate ? { sessionCandidateReceipt: options.sessionCandidate } : {}),
        },
      );
    });
    print.result(result);
  } catch (error) {
    if (error instanceof ContextPluginReloadRequiredError) {
      print.fail(error.code, error.message, 2, {
        nextActions:
          provider === "claude-code"
            ? ["Start a new Claude session, then retry the same route command."]
            : ["Repair the Codex Context Plugin, then retry the same route command."],
      });
    }
    throw error;
  }
}

export const contextRouteCommand: SubcommandModule = {
  name: "route",
  hidden: true,
  alias: "",
  summary: "",
  description: "Resolve locally authorized Teams to exact root SCOPE receipts.",
  configure,
  action: runContextRoute,
};
