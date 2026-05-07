import { IntegrationsPage } from "../integrations.js";

/**
 * Integrations sub-route under /settings. Renders the existing
 * IntegrationsPage in embedded mode so it slots into the master-detail
 * layout without escaping the surrounding chrome.
 */
export function SettingsIntegrationsPage() {
  return <IntegrationsPage embedded />;
}
