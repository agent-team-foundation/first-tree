import { ContextPage } from "./context.js";
import { MOCK_CONTEXT_SNAPSHOT } from "./context-preview-mock.js";

export function ContextPreviewPage() {
  return <ContextPage previewSnapshot={MOCK_CONTEXT_SNAPSHOT} />;
}
