#!/usr/bin/env node
// P16 Gate C C5 — capability qualification runner (L1/L2/L3).
//
//   node scripts/testing/run-provider-qualification.mjs --layer L1|L2|L3 \
//        [--deployment-id <id>]
//
// L1 = codec/contract fixtures (offline)      -> actually executed
// L2 = controlled transport + ProviderRuntime -> actually executed
// L3 = real endpoint three-run                -> evidence-presence check ONLY;
//      without a real endpoint the layer stays NOT_RUN and is NEVER marked
//      PASS (INV-C3-1: no capability is proven without running its oracle).
//
// Prints the aggregation; evidence artifacts are referenced from the
// per-deployment qualification records under
// planning/testing/provider-qualification/<deploymentId>/qualification.json

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const QUALIFICATION_RUNNER_VERSION = "qrun-1.0.0";

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const layer = arg("--layer");
if (!["L1", "L2", "L3"].includes(layer ?? "")) {
  console.error(
    "usage: run-provider-qualification.mjs --layer L1|L2|L3 [--deployment-id id]",
  );
  process.exit(1);
}
const runId = `q-${layer}-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;

if (layer === "L1" || layer === "L2") {
  const suite =
    layer === "L1"
      ? "tests/provider-qualification/p16-gate-c-l1-contracts.test.ts"
      : "tests/provider-qualification/p16-gate-c-l2.test.ts";
  const vitest = spawnSync("npx", ["vitest", "run", suite], {
    cwd: root,
    stdio: "inherit",
  });
  const verdict = vitest.status === 0 ? "PASS" : "FAIL";
  console.log(`\nqualificationRun=${runId}`);
  console.log(`layer=${layer} suite=${suite} verdict=${verdict}`);
  console.log(`runnerVersion=${QUALIFICATION_RUNNER_VERSION}`);
  process.exit(vitest.status === 0 ? 0 : 1);
}

// L3: evidence-presence check only — never fabricates a PASS.
const deploymentId = arg("--deployment-id");
const evidenceDir = join(
  root,
  "planning/testing/core-capability/evidence/real-provider",
);
let evidenceCount = 0;
try {
  const { readdirSync } = await import("node:fs");
  evidenceCount = readdirSync(evidenceDir).filter((name) =>
    /-L3-REAL-.*\.json$/.test(name),
  ).length;
} catch {
  evidenceCount = 0;
}
if (deploymentId === undefined) {
  console.log(`qualificationRun=${runId}`);
  console.log(
    `layer=L3 status=NOT_RUN (no --deployment-id given; real-endpoint three-run is a governance-triggered activity)`,
  );
  console.log(`runnerVersion=${QUALIFICATION_RUNNER_VERSION}`);
  process.exit(0);
}
if (evidenceCount < 3) {
  console.log(`qualificationRun=${runId}`);
  console.log(
    `layer=L3 deployment=${deploymentId} status=NOT_RUN (evidence files: ${evidenceCount} < 3)`,
  );
  console.log(`runnerVersion=${QUALIFICATION_RUNNER_VERSION}`);
  process.exit(0);
}
console.log(`qualificationRun=${runId}`);
console.log(
  `layer=L3 deployment=${deploymentId} evidenceFiles=${evidenceCount} status=EVIDENCE_PRESENT (per-capability PROVEN still requires the frozen L3 oracles)`,
);
console.log(`runnerVersion=${QUALIFICATION_RUNNER_VERSION}`);
