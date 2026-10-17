import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const vitestEntry = require.resolve("vitest");
const vitestCli = join(dirname(vitestEntry), "vitest.mjs");
export const DEFAULT_BATCH_SIZE = 20;
export const BATCH_SIZE_ENV = "ARBOR_CORE_TEST_BATCH_SIZE";

export function parseBatchSize(value, fallback = DEFAULT_BATCH_SIZE) {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${BATCH_SIZE_ENV} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${BATCH_SIZE_ENV} must be a positive integer`);
  }
  return parsed;
}

export function sortAndBatchFiles(files, batchSize) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }
  const sorted = [...files].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const batches = [];
  for (let offset = 0; offset < sorted.length; offset += batchSize) {
    batches.push(sorted.slice(offset, offset + batchSize));
  }
  return batches;
}

function childFailure(result) {
  if (result.error) return result.error.message;
  if (result.signal) return `terminated by ${result.signal}`;
  return `exited with status ${result.status ?? 1}`;
}

function childExitCode(result) {
  if (result.signal === "SIGINT") return 130;
  if (result.signal === "SIGTERM") return 143;
  return result.status && result.status > 0 ? result.status : 1;
}

export function runCoreTests({
  cwd = root,
  cliPath = vitestCli,
  env = process.env,
  run = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  let batchSize;
  try {
    batchSize = parseBatchSize(env[BATCH_SIZE_ENV]);
  } catch (cause) {
    error(`core test runner: ${cause.message}`);
    return 2;
  }

  const listing = run(process.execPath, [cliPath, "list", "--filesOnly"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  if (listing.error || listing.status !== 0) {
    error(`core test runner: Vitest file listing ${childFailure(listing)}`);
    return childExitCode(listing);
  }
  const files = listing.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length === 0) {
    error("core test runner: Vitest listed no default root-suite files");
    return 1;
  }

  const batches = sortAndBatchFiles(files, batchSize);
  log(
    `core tests: ${files.length} files in ${batches.length} sequential batches (batch size ${batchSize})`,
  );
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    log(
      `core tests: batch ${index + 1}/${batches.length} (${batch.length} files)`,
    );
    const result = run(
      process.execPath,
      [
        cliPath,
        "run",
        ...batch,
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--retry=0",
      ],
      { cwd, stdio: "inherit", windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      error(
        `core tests: batch ${index + 1}/${batches.length} failed (${childFailure(result)})`,
      );
      return childExitCode(result);
    }
  }
  log(`core tests: all ${files.length} files passed`);
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runCoreTests();
}
