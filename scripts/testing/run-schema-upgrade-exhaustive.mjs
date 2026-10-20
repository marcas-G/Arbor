import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const vitestEntry = require.resolve("vitest");
const vitestCli = join(dirname(vitestEntry), "vitest.mjs");

const result = spawnSync(
  process.execPath,
  [
    vitestCli,
    "run",
    "--config",
    "vitest.config.ts",
    "apps/single-workspace/test/schema-upgrade-operator.test.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
    "--retry=0",
    "--testNamePattern",
    String.raw`\[exhaustive\]`,
  ],
  {
    cwd: root,
    env: { ...process.env, ARBOR_EXHAUSTIVE_SCHEMA_UPGRADE: "1" },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error !== undefined) throw result.error;
if (result.signal === "SIGINT") process.exitCode = 130;
else if (result.signal === "SIGTERM") process.exitCode = 143;
else process.exitCode = result.status ?? 1;
