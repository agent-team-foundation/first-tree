import "./zod-jitless.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { captureReactRootError, initWebSentry } from "./observability/sentry.js";
import "./index.css";

initWebSentry();

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root, {
  onCaughtError: captureReactRootError,
  onRecoverableError: captureReactRootError,
  onUncaughtError: captureReactRootError,
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
