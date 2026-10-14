# Test profiles

`planning/testing/manifest.json` is the checked inventory for the configured functional test files. `pnpm test:manifest` verifies that its 48 functional Vitest paths and 6 UI paths still match the committed Vitest and Playwright configuration.

| Command | Selected inventory | Coverage claim |
|---|---|---|
| `pnpm test:functional:quick` / `pnpm test:quick` | Three named module tests plus root/Web build and Web typecheck | Focused L1 check only |
| `pnpm test:functional:smoke` / `pnpm test:smoke` | S1–S4, three named public journeys, and safe daemon-startup handshake | Selected smoke evidence only |
| `pnpm test:functional:crash-sentinels` / `pnpm test:crash-sentinels` | Curated process, lease, and provider handoff sentinels | Named sentinels only; not all AH10 handlers or AH1–AH19 qualification |
| `pnpm test:functional:package` / `pnpm test:package` | Clean committed-checkout F20 case | Package boundary only |
| `pnpm test:ui` | All six configured browser files | Browser suite only |
| `pnpm test:functional` / `pnpm test:release` / `pnpm test:all` | All 48 configured Vitest files and all 6 UI files | Full configured deterministic functional inventory |

The runner writes an initial `running` JSON result and Markdown summary atomically before it starts external commands. It refreshes these files as groups and commands progress. When it catches SIGINT, SIGTERM, an uncaught exception, or an unhandled rejection, it records `interrupted`, leaves `completeCoverage` false, and records the active group, command, exit code, and signal when available. Abrupt termination such as SIGKILL can leave the last persisted `running` result visible.

The runner's one-time root and Web build applies to the checked-out workspace. The clean-checkout F20 test independently creates a temporary clone, installs the frozen lockfile offline, builds that clone, starts its daemon, and runs S1–S4. That nested package qualification intentionally repeats installation and builds; it is not covered by the runner's one-time build.

Release and `test:functional` always select the full manifest groups, disable Vitest cache, and use zero Playwright retries. Quick, smoke, and crash-sentinels are subsets and cannot claim complete release coverage. The runner does not move or remove any existing test assertions.
