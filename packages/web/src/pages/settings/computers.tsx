import { ClientsPage } from "../clients.js";

/**
 * Computers sub-route under /settings. Renders the existing ClientsPage in
 * embedded mode so it slots into the master-detail layout without escaping
 * the surrounding chrome.
 */
export function SettingsComputersPage() {
  return <ClientsPage embedded />;
}
