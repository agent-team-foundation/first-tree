import { config as configureZod } from "zod";

/**
 * Start the browser application without probing dynamic code generation.
 *
 * Zod object schemas detect JIT support with `Function(...)` when they are
 * constructed. Under an enforced CSP, browsers block that probe even though
 * Zod catches the exception and falls back. Configure the supported jitless
 * path before dynamically evaluating any application module that constructs a
 * Shared schema.
 */
export async function startBrowserApp(): Promise<void> {
  configureZod({ jitless: true });
  const { mountBrowserApp } = await import("./browser-app.js");
  mountBrowserApp();
}
