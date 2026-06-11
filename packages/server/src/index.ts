import { startServer } from "./bootstrap-server.js";
import { createLogger } from "./observability/index.js";

startServer().catch((err) => {
  const bootLog = createLogger("Bootstrap");
  bootLog.fatal({ err }, "failed to start server");
  process.exit(1);
});
