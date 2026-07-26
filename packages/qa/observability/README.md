# Evidence And Performance Guidance

Every formal conclusion must point to evidence that supports it. Choose the least evidence that makes the claim credible;
no single evidence type applies to every surface.

## Evidence Menu

- CLI output, exit status, installed files, and independent state readback.
- Service logs, HTTP/API/WS observations, database state, and restart/reconnect behavior.
- Browser-visible state, screenshots, console/network output, accessibility state, and downloads.
- SDK consumer, daemon/worker, provider/runtime, installer, migration, and portable-artifact observations.

Source, logs, mocks, test assertions, and direct database setup help diagnosis or establish preconditions but rarely
prove public product behavior alone.

## Readiness Performance

During harness initialization, record a lightweight characterization for every formal surface when applicable:

- dependency/install and build duration;
- final artifact, package, image, or bundle size;
- start-to-ready or first-consumer duration;
- idle CPU, memory, process/container, and disk state;
- driver/observer response and reset/reprobe duration.

One readiness sample proves measurement capability, not a statistical regression. Run deeper sampling only when the task,
an SLO, a case, a change risk, or an observed issue requires it. State workload, environment, sample count, cold/warm
state, raw errors, and baseline/SLO before claiming a regression.

## Redaction

Redact tokens, cookies, auth headers, provider credentials, private connection strings, personal data, and private
session content. Keep enough sanitized context to interpret the result and retain sensitive evidence only at safe local
paths.
