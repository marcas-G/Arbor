#!/usr/bin/env node

// P16 `02` E3 — Provider Conformance Suite runner.
//
// The suite itself lives in tests/provider-conformance/ and runs offline via
// injected transport doubles. This runner is the mechanical entry the
// qualification record references (`conformanceRun`): it prints a stable run
// id and the per-adapter verdict.
//
// Usage:
//   node scripts/testing/run-provider-conformance.mjs [--adapter provider-openai]
// Exit code: 0 iff every selected adapter target passed.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const adapterIndex = args.indexOf("--adapter");
const adapter = adapterIndex >= 0 ? args[adapterIndex + 1] : undefined;
const runId = `conf-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

const vitest = spawnSync(
  "npx",
  [
    "vitest",
    "run",
    "tests/provider-conformance/provider-conformance.test.ts",
    ...(adapter !== undefined ? ["-t", adapter] : []),
  ],
  { cwd: root, stdio: "inherit" },
);

const verdict = vitest.status === 0 ? "PASS" : "FAIL";
console.log(`\nconformanceRun=${runId}`);
console.log(`adapter=${adapter ?? "all"} verdict=${verdict}`);
process.exit(vitest.status === 0 ? 0 : 1);
