import { useEffect, useState } from "react";

/**
 * Track `value` with a trailing delay — `useDebouncedValue(input, 200)`
 * returns whichever value `input` settles on for `delayMs` ms. Each new
 * value resets the timer, so a fast typist stays at the previous settled
 * value until the burst ends.
 *
 * Use for search inputs that drive a server round-trip: wire the textarea
 * to local state, feed that state through this hook, and key the query off
 * the returned value. The picker uses it so each keystroke does not fan
 * out into per-character `GET /agents?query=` requests.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
