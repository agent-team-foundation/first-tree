import type { CapabilityEntry } from "@first-tree/shared";
import { runDetect } from "./detect.js";

/** Exact SDK build bundled with the client and used by the runtime handler. */
export const KIMI_CODE_SDK_VERSION = "0.26.0-botiverse.2";

/**
 * Install-only Kimi capability. The SDK is a declared client dependency, so
 * detection does not launch Kimi, touch credentials, or make a network call.
 */
export async function probeKimiCodeCapability(): Promise<CapabilityEntry> {
  return runDetect(async () => ({
    installed: true,
    version: KIMI_CODE_SDK_VERSION,
    runtimeSource: "bundled",
    runtimePath: null,
  }));
}
