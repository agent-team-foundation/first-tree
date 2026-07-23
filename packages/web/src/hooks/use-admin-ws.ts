type WsMessage = {
  type: string;
  [key: string]: unknown;
};

type UseAdminWsOptions = {
  /** Called for every incoming WS message once the authority-scoped client is enabled. */
  onMessage?: (msg: WsMessage) => void;
  /** Whether the hook should subscribe once the authority-scoped client is enabled. */
  enabled?: boolean;
};

/**
 * Admin WebSocket transport is intentionally inactive until AuthContext is
 * backed by BrowserSessionRuntime and can supply an exact
 * account/organization/view/credential admission.
 *
 * The former origin-global singleton read credentials and organization state
 * directly from mutable module/localStorage state. Leaving that transport
 * active while the session integration is incomplete would let an old view
 * authenticate or deliver frames into a replacement view. HTTP query polling
 * remains the product fallback during this intermediate implementation slice.
 */
export function useAdminWs(_options?: UseAdminWsOptions): void {
  // Deliberately no transport side effect. The next Auth integration slice
  // will accept an opaque runtime-owned admission rather than reviving the
  // legacy global singleton.
}
