import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectRunnerProcess,
  repairRunningResult,
  runnerHostName,
} from "./result-repair.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resultsRoot = join(root, ".test-results");

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help" || name === "-h") return { help: true };
    if (!name?.startsWith("--")) {
      throw new Error(`unexpected argument: ${name ?? ""}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    if (values.has(name)) throw new Error(`${name} may be specified once`);
    values.set(name, value);
    index += 1;
  }
  return {
    runId: values.get("--runId"),
    evidence: values.get("--evidence"),
  };
}

function atomicWrite(path, contents) {
  const temporaryPath = `${path}.repair-${process.pid}`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
  const descriptor = openSync(temporaryPath, "r+");
  try {
    // Flush the repaired manifest before atomically replacing the old one.
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
}

function help() {
  return [
    "Usage: node scripts/testing/repair-results.mjs --runId <run-id> --evidence <manual-evidence>",
    "",
    "Repairs one stale running manifest in this workspace and records the supplied evidence.",
    "For manifests with runner PID metadata, repair is allowed only when the same-host PID is absent.",
    "Legacy manifests require explicit operator evidence because they have no process identity.",
  ].join("\n");
}

function validateRunId(runId) {
  if (
    typeof runId !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/u.test(runId)
  ) {
    throw new Error("--runId must be an exact test-run ID");
  }
  const resultDirectory = resolve(resultsRoot, runId);
  if (dirname(resultDirectory) !== resultsRoot) {
    throw new Error("--runId resolves outside this workspace's .test-results");
  }
  return join(resultDirectory, "result-manifest.json");
}

function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.help) {
    console.log(help());
    return;
  }
  if (!args.runId || !args.evidence) {
    throw new Error("both --runId and --evidence are required");
  }
  const manifestPath = validateRunId(args.runId);
  const result = JSON.parse(readFileSync(manifestPath, "utf8"));
  const currentHostName = runnerHostName();
  const processState = inspectRunnerProcess(
    result.runner,
    currentHostName,
    (pid) => process.kill(pid, 0),
  );
  const repaired = repairRunningResult(result, {
    runId: args.runId,
    currentHostName,
    processState,
    evidence: args.evidence,
  });
  atomicWrite(manifestPath, `${JSON.stringify(repaired, null, 2)}\n`);
  console.log(
    `Marked ${args.runId} interrupted; last heartbeat ${repaired.lastHeartbeatAt ?? "none"} was preserved.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`repair-results: ${error.message}`);
    process.exitCode = 2;
  }
}
