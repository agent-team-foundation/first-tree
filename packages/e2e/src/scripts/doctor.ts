import { runDoctor } from "../framework/doctor.js";
import { loadE2EEnv, REPO_ROOT } from "../framework/env.js";

function main(): void {
  try {
    const env = loadE2EEnv();
    const result = runDoctor(REPO_ROOT);
    if (result.ok) {
      console.log("e2e:doctor OK");
      console.log(`  docker compose bin: ${env.E2E_DOCKER_COMPOSE_BIN ?? result.dockerComposeBin}`);
      console.log(`  pg image: ${env.E2E_PG_IMAGE}`);
      console.log(`  port range: ${env.E2E_PORT_MIN}–${env.E2E_PORT_MAX}`);
      process.exit(0);
    }
    console.error("e2e:doctor FAILED");
    for (const issue of result.issues) {
      console.error(`  [${issue.kind}] ${issue.what}: ${issue.detail}`);
    }
    process.exit(1);
  } catch (err) {
    console.error("e2e:doctor crashed:", err);
    process.exit(2);
  }
}

main();
