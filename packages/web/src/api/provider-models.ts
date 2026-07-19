import type { ProviderModelCatalog, RuntimeProvider } from "@first-tree/shared";
import { ApiError, api } from "./client.js";

/**
 * Fetch the model catalog discovered on a computer's real provider install
 * (daemon-side discovery, proxied by the server on demand). Powers the
 * unified Model picker.
 *
 * Returns `null` when the catalog cannot be produced at all — an older
 * server without the route (404), an older daemon that doesn't answer the
 * models command (501), or the computer being unreachable (502/504). The
 * picker degrades silently for those mapped statuses only. Any other failure
 * (401/403/500/503, …) is rethrown so the UI can show an explicit error/retry
 * instead of masking it as ordinary unavailability. Check `ApiError.status`
 * (never the message text) for the silent mapping, mirroring
 * `getGithubAppInstallation`.
 */
export async function getProviderModels(
  clientId: string,
  provider: RuntimeProvider,
): Promise<ProviderModelCatalog | null> {
  try {
    return await api.get<ProviderModelCatalog>(
      `/clients/${encodeURIComponent(clientId)}/providers/${encodeURIComponent(provider)}/models`,
    );
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.status === 404 || err.status === 501 || err.status === 502 || err.status === 504)
    ) {
      return null;
    }
    throw err;
  }
}
