import type { HandlerFactory } from "../../runtime/handler.js";
import { createCursorSdkHandler } from "./sdk.js";

export { createCursorSdkHandler } from "./sdk.js";

/**
 * Cursor handler factory. Unlike codex there is no dual engine — cursor drives
 * the `cursor-agent` CLI through a single per-turn child-process handler, so
 * this just delegates to {@link createCursorSdkHandler}.
 */
export const createCursorHandler: HandlerFactory = (config) => createCursorSdkHandler(config);
