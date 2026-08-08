/**
 * Provider-support process-supervision group.
 *
 * Runtime owns default provider-process lifecycle supervision (spawn, timeout,
 * tear-down). Adapters consume this allowlist instead of deep-importing the
 * owner module. No concrete provider binary or handler implementation is
 * re-exported here.
 */

export type {
  ProviderProcessSpec,
  ProviderProcessSupervisor,
  SupervisedProviderProcess,
} from "../provider-process-supervisor.js";
export {
  createDefaultProviderProcessSupervisor,
  ProviderProcessSupervisionUnsupportedError,
  supportsDefaultProviderProcessSupervision,
} from "../provider-process-supervisor.js";
