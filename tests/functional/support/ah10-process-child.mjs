import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import { Principal, parse } from "../../../packages/domain/dist/index.js";
import {
  BUILTIN_EXECUTORS,
  SHELL_DEFINITION,
} from "../../../packages/tool-runtime/dist/index.js";
import {
  createAh19StartupDiagnosticProbe,
  createFunctionalDaemonListenReporter,
} from "./functional-daemon-lifecycle.mjs";
import { functionalTestMain } from "./functional-test-composition.mjs";

const role = process.env.ARBOR_AH10_ROLE;
if (role !== "old" && role !== "new") {
  throw new Error("AH10 test child needs role=old|new");
}
const databaseFile = process.env.ARBOR_DB;
if (databaseFile === undefined)
  throw new Error("AH10 test child needs ARBOR_DB");
const onWebTransportListening = createFunctionalDaemonListenReporter();
const startupDiagnosticProbe = createAh19StartupDiagnosticProbe(
  process.env.ARBOR_AH19_STARTUP_TRACE === "1",
);
const sandboxAuthoritySourceFile =
  process.env.ARBOR_SANDBOX_AUTHORITY_SOURCE_FILE;
const trustedHostConfigurationSource =
  sandboxAuthoritySourceFile === undefined
    ? undefined
    : {
        readVerifiedSandboxAuthorityBundle: () =>
          Effect.sync(() => {
            const pair = JSON.parse(
              readFileSync(sandboxAuthoritySourceFile, "utf8"),
            );
            return {
              sourceIdentity: pair.sourceIdentity,
              canonicalJson: pair.bundleCanonicalJson,
            };
          }),
        readSandboxAuthorityHighWater: () =>
          Effect.sync(
            () =>
              JSON.parse(readFileSync(sandboxAuthoritySourceFile, "utf8"))
                .highWaterCanonicalJson,
          ),
        commitSandboxAuthorityHighWater: () => Effect.succeed(false),
        appendSandboxAuthorityAudit: (canonicalJson) =>
          Effect.sync(() => {
            appendFileSync(
              `${sandboxAuthoritySourceFile}.audit`,
              `${canonicalJson}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            return true;
          }),
      };
const governance = {
  authenticatedHumans: [
    parse(Principal)("user:local"),
    parse(Principal)("user:operator"),
  ],
  directParentOf: [],
};
const projectResourceProfiles = makeProjectResourceProfilePort(
  projectResourceProfilesFromEnvironment(),
);
const gateDirectory = join(dirname(databaseFile), "ah10-gates");
const reconciliationSourceReturnsFile = join(
  gateDirectory,
  "reconciliation-source-returns.jsonl",
);

const appendReconciliationSourceRecord = (record) => {
  mkdirSync(gateDirectory, { recursive: true });
  appendFileSync(
    reconciliationSourceReturnsFile,
    `${JSON.stringify(record)}\n`,
    { encoding: "utf8" },
  );
};
const recoveryProbeEvents = new Set();
const reconciliationMode = process.env.ARBOR_AH7_TEST_RECONCILIATION_MODE;
const reconciliationProfileDrift = process.env.ARBOR_AH7_TEST_PROFILE_DRIFT;
const reconciliationProofMismatch = process.env.ARBOR_AH7_TEST_PROOF_MISMATCH;
const reconciliationProfileHash = createHash("sha256")
  .update(
    reconciliationProfileDrift === "hash"
      ? "arbor-ah7-test-reconciliation-profile-v2"
      : "arbor-ah7-test-reconciliation-profile-v1",
  )
  .digest("hex");

let testReconciliationConfig;
if (reconciliationMode !== undefined) {
  if (
    reconciliationMode !== "NotOccurred" &&
    reconciliationMode !== "Occurred" &&
    reconciliationMode !== "StillUnknown"
  ) {
    throw new Error(
      `unsupported AH7 test reconciliation mode: ${reconciliationMode}`,
    );
  }
  if (
    reconciliationProofMismatch !== undefined &&
    reconciliationProofMismatch !== "attemptNo" &&
    reconciliationProofMismatch !== "visibilityScopeSha256"
  ) {
    throw new Error(
      `unsupported AH7 test reconciliation proof mismatch: ${reconciliationProofMismatch}`,
    );
  }
  // The isolated test child replaces the production shell definition with a
  // synthetic, version/hash-bound Reconcilable descriptor. Ordinary daemon
  // composition continues to expose shell@3 as NonIdempotent.
  SHELL_DEFINITION.hash = "shell-v3-ah7-test-reconciliation";
  SHELL_DEFINITION.sideEffectSemantics = "Reconcilable";
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ah7_test_external_effects (
      effect_key TEXT PRIMARY KEY,
      result_ref TEXT,
      recorded_at TEXT NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS ah7_test_reconciliation_controls (
      invocation_id TEXT PRIMARY KEY,
      resource_boundary_changed_at TEXT NOT NULL
    )`);
  } finally {
    db.close();
  }

  const profile = {
    toolName: "shell",
    toolVersion: SHELL_DEFINITION.version,
    toolDefinitionHash: SHELL_DEFINITION.hash,
    profileId: "ah7-test-external-ledger",
    profileVersion: reconciliationProfileDrift === "version" ? "2" : "1",
    profileHash: reconciliationProfileHash,
    profileProtocol: "ah7-test-ledger-v1",
    effectKey: ({ invocationId }) =>
      reconciliationProfileDrift === "effect-key"
        ? `ah7-test-v2:${invocationId}`
        : `ah7-test:${invocationId}`,
    reconstructOccurred: ({ bytes, settlement }) => ({
      settlement,
      observation: {
        text: new TextDecoder().decode(bytes),
        truncated: false,
      },
    }),
  };
  const effectKey = (invocationId) => `ah7-test:${invocationId}`;
  const proofForRequest = (request, evidenceArtifact) => {
    const proof = {
      invocationId: request.invocationId,
      attemptNo: request.attemptNo,
      bindingSha256: request.bindingSha256,
      profileHash: request.profileHash,
      effectKey: request.effectKey,
      sourceRevision: "test-ledger-v1",
      sourceWatermark: "test-ledger-final-watermark",
      observedAt: new Date().toISOString(),
      visibilityScopeSha256: request.visibilityScopeSha256,
      evidenceRef: evidenceArtifact.artifact_id,
      evidenceSha256: evidenceArtifact.content_hash,
      finality: {
        _tag: "ExternallyFenced",
        confirmationRef: "test-ledger-no-effect-fence",
        confirmedAt: new Date().toISOString(),
      },
    };
    if (reconciliationProofMismatch === "attemptNo") {
      return { ...proof, attemptNo: request.attemptNo === 0 ? 1 : 0 };
    }
    if (reconciliationProofMismatch === "visibilityScopeSha256") {
      return {
        ...proof,
        visibilityScopeSha256: `${request.visibilityScopeSha256.slice(0, -1)}${request.visibilityScopeSha256.endsWith("0") ? "1" : "0"}`,
      };
    }
    return proof;
  };
  const testReconciliationPort = {
    reconcile: (request) => {
      let stage = "open-source-database";
      return Effect.tryPromise({
        try: async () => {
          const source = new DatabaseSync(databaseFile);
          try {
            stage = "read-source-state-and-prepare-result";
            source.exec(`CREATE TABLE IF NOT EXISTS ah7_test_reconciliation_calls (
            call_no INTEGER PRIMARY KEY AUTOINCREMENT,
            invocation_id TEXT NOT NULL,
            attempt_no INTEGER NOT NULL,
            role TEXT NOT NULL,
            observed_effect INTEGER NOT NULL,
            returned_at TEXT
          )`);
            const effect = source
              .prepare(
                "SELECT result_ref FROM ah7_test_external_effects WHERE effect_key = ?",
              )
              .get(effectKey(request.invocationId));
            const evidence = source
              .prepare(
                "SELECT artifact_id, content_hash FROM artifacts WHERE kind = 'tool-result:read' ORDER BY created_at, artifact_id",
              )
              .all();
            const evidenceArtifact = evidence[0];
            const observedEffect = effect === undefined ? 0 : 1;
            const call = source
              .prepare(
                `INSERT INTO ah7_test_reconciliation_calls
                 (invocation_id, attempt_no, role, observed_effect)
               VALUES (?, ?, ?, ?)`,
              )
              .run(
                request.invocationId,
                request.attemptNo,
                role,
                observedEffect,
              );
            stage = "wait-for-source-gate";
            const callNo = Number(call.lastInsertRowid);
            const event = {
              boundary: "AH7ReconciliationSourceIO",
              invocationId: request.invocationId,
              attemptNo: request.attemptNo,
              role,
              callNo,
              observedEffect,
            };
            const notOccurredResult =
              reconciliationMode === "NotOccurred" &&
              effect === undefined &&
              evidenceArtifact !== undefined
                ? {
                    _tag: "NotOccurred",
                    proof: proofForRequest(request, evidenceArtifact),
                  }
                : undefined;
            const recordSourceReturn = () => {
              stage = "append-source-return-side-channel";
              const returnedAt = new Date().toISOString();
              const gatePath = join(
                gateDirectory,
                `${role}-reconciliation-io.release`,
              );
              const sourceReturnRecord = {
                kind: "returned",
                pid: process.pid,
                role,
                callNo,
                invocationId: request.invocationId,
                attemptNo: request.attemptNo,
                observedEffect,
                timestamp: returnedAt,
                gatePath,
              };
              try {
                appendReconciliationSourceRecord(sourceReturnRecord);
              } catch (cause) {
                try {
                  process.stderr.write(
                    `AH7 source-return side-channel append failed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
                  );
                } catch {
                  // Preserve the source-return append failure.
                }
                try {
                  appendReconciliationSourceRecord({
                    kind: "error",
                    pid: process.pid,
                    role,
                    callNo,
                    invocationId: request.invocationId,
                    attemptNo: request.attemptNo,
                    observedEffect,
                    stage: "append-source-return-side-channel",
                    error:
                      cause instanceof Error ? cause.message : String(cause),
                    gatePath,
                    timestamp: new Date().toISOString(),
                  });
                } catch {
                  // Preserve the original side-channel write failure.
                }
                throw cause;
              }
              setImmediate(() => {
                let returnedAtDb;
                try {
                  returnedAtDb = new DatabaseSync(databaseFile);
                  returnedAtDb
                    .prepare(
                      "UPDATE ah7_test_reconciliation_calls SET returned_at = ? WHERE call_no = ?",
                    )
                    .run(returnedAt, callNo);
                } catch (cause) {
                  try {
                    appendReconciliationSourceRecord({
                      kind: "error",
                      pid: process.pid,
                      role,
                      callNo,
                      invocationId: request.invocationId,
                      attemptNo: request.attemptNo,
                      observedEffect,
                      stage: "best-effort-returned-at-update",
                      error:
                        cause instanceof Error ? cause.message : String(cause),
                      gatePath,
                      timestamp: new Date().toISOString(),
                    });
                  } catch {
                    // The test adapter must not delay its already-recorded result.
                  }
                } finally {
                  returnedAtDb?.close();
                }
              });
            };
            if (
              process.env.ARBOR_AH7_TEST_TRACE_RECONCILIATION_IO === "1" ||
              process.env.ARBOR_AH7_TEST_PAUSE_RECONCILIATION_IO === "1"
            ) {
              process.stdout.write(
                `${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`,
              );
            }
            if (process.env.ARBOR_AH7_TEST_PAUSE_RECONCILIATION_IO === "1") {
              writeFileSync(
                join(gateDirectory, `${role}-reconciliation-io.started`),
                JSON.stringify(event),
              );
              await waitForGate("reconciliation-io", event);
            }
            const reconciliationDrift =
              process.env.ARBOR_AH7_TEST_DRIFT_ON_RECONCILE;
            const hasPostGateMutation =
              process.env.ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE === "1" ||
              ["authority", "approval", "stop"].includes(reconciliationDrift);
            if (notOccurredResult !== undefined && !hasPostGateMutation) {
              stage = "append-source-return-side-channel";
              recordSourceReturn();
              return notOccurredResult;
            }
            stage = "apply-post-gate-reconciliation-mutation";
            if (
              process.env.ARBOR_AH7_TEST_RESOURCE_CHANGE_ON_RECONCILE === "1"
            ) {
              const changed = source
                .prepare(
                  "SELECT 1 FROM ah7_test_reconciliation_controls WHERE invocation_id = ?",
                )
                .get(request.invocationId);
              if (changed === undefined) {
                const invocation = source
                  .prepare(
                    "SELECT workspace_id FROM tool_invocations WHERE invocation_id = ?",
                  )
                  .get(request.invocationId);
                if (invocation === undefined) {
                  throw new Error(
                    "AH7 test profile could not read invocation Workspace",
                  );
                }
                const workspace = source
                  .prepare(
                    "SELECT resource_boundary FROM workspaces WHERE workspace_id = ?",
                  )
                  .get(invocation?.workspace_id);
                if (workspace === undefined) {
                  throw new Error(
                    "AH7 test profile could not read Workspace boundary",
                  );
                }
                const boundary = JSON.parse(workspace.resource_boundary);
                const addresses = Array.isArray(boundary.addresses)
                  ? boundary.addresses
                  : [];
                const firstAddress = addresses[0];
                if (
                  typeof firstAddress !== "object" ||
                  firstAddress === null ||
                  typeof firstAddress.path !== "string"
                ) {
                  throw new Error(
                    "AH7 test profile Workspace boundary is malformed",
                  );
                }
                firstAddress.path = `${firstAddress.path}.changed-during-reconcile`;
                source
                  .prepare(
                    "UPDATE workspaces SET resource_boundary = ? WHERE workspace_id = ?",
                  )
                  .run(JSON.stringify(boundary), invocation.workspace_id);
                source
                  .prepare(
                    "INSERT INTO ah7_test_reconciliation_controls (invocation_id, resource_boundary_changed_at) VALUES (?,?)",
                  )
                  .run(request.invocationId, new Date().toISOString());
              }
            }
            if (
              reconciliationMode === "NotOccurred" &&
              ["authority", "approval", "stop"].includes(reconciliationDrift)
            ) {
              const changed = source
                .prepare(
                  "SELECT 1 FROM ah7_test_reconciliation_controls WHERE invocation_id = ?",
                )
                .get(request.invocationId);
              if (changed === undefined) {
                const invocation = source
                  .prepare(
                    `SELECT i.execution_id, w.project_id
                     FROM tool_invocations i
                     JOIN workspaces w ON w.workspace_id = i.workspace_id
                    WHERE i.invocation_id = ?`,
                  )
                  .get(request.invocationId);
                if (invocation === undefined) {
                  throw new Error(
                    "AH7 test profile could not resolve drift target",
                  );
                }
                if (reconciliationDrift === "authority") {
                  source
                    .prepare(
                      "UPDATE permission_grants SET state = 'Revoked' WHERE project_id = ? AND state = 'Active'",
                    )
                    .run(invocation.project_id);
                } else if (reconciliationDrift === "approval") {
                  source
                    .prepare(
                      "UPDATE action_approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE tool_invocation_id = ? AND route_kind = 'Executable' AND state = 'Consumed'",
                    )
                    .run(request.invocationId);
                } else {
                  source
                    .prepare(
                      "UPDATE executions SET stop_requested_at = ? WHERE execution_id = ? AND stop_requested_at IS NULL AND settled_at IS NULL",
                    )
                    .run(new Date().toISOString(), invocation.execution_id);
                }
                source
                  .prepare(
                    "INSERT INTO ah7_test_reconciliation_controls (invocation_id, resource_boundary_changed_at) VALUES (?,?)",
                  )
                  .run(request.invocationId, new Date().toISOString());
              }
            }
            if (hasPostGateMutation) {
              stage = "prepare-reconciliation-result";
            }
            if (reconciliationMode === "StillUnknown") {
              recordSourceReturn();
              return {
                _tag: "StillUnknown",
                reasonCode: "AttemptNotFinal",
                evidenceRef: null,
              };
            }
            if (reconciliationMode === "Occurred" && effect?.result_ref) {
              if (evidenceArtifact === undefined) {
                recordSourceReturn();
                return {
                  _tag: "StillUnknown",
                  reasonCode: "ResultEvidenceUnavailable",
                  evidenceRef: null,
                };
              }
              recordSourceReturn();
              return {
                _tag: "Occurred",
                proof: {
                  invocationId: request.invocationId,
                  attemptNo: request.attemptNo,
                  bindingSha256: request.bindingSha256,
                  profileHash: request.profileHash,
                  effectKey: request.effectKey,
                  sourceRevision: "test-ledger-v1",
                  sourceWatermark: "test-ledger-final-watermark",
                  observedAt: new Date().toISOString(),
                  visibilityScopeSha256: request.visibilityScopeSha256,
                  evidenceRef: evidenceArtifact.artifact_id,
                  evidenceSha256: evidenceArtifact.content_hash,
                  finality: {
                    _tag: "FinalityHorizonElapsed",
                    horizon: "test-ledger-terminal-watermark",
                    elapsedAt: new Date().toISOString(),
                  },
                },
                settlement: "Success",
                resultRef: effect.result_ref,
              };
            }
            if (
              reconciliationMode === "NotOccurred" &&
              effect === undefined &&
              evidenceArtifact !== undefined
            ) {
              const result = notOccurredResult;
              if (result === undefined) {
                throw new Error(
                  "AH7 NotOccurred result was not prepared before source return",
                );
              }
              recordSourceReturn();
              return result;
            }
            recordSourceReturn();
            return {
              _tag: "StillUnknown",
              reasonCode: "AttemptNotFinal",
              evidenceRef: null,
            };
          } finally {
            source.close();
          }
        },
        catch: (cause) => {
          try {
            process.stderr.write(
              `AH7 reconciliation adapter failed at ${stage}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`,
            );
          } catch {
            // Preserve the original adapter failure.
          }
          try {
            appendReconciliationSourceRecord({
              kind: "error",
              pid: process.pid,
              role,
              invocationId: request.invocationId,
              attemptNo: request.attemptNo,
              stage,
              error: cause instanceof Error ? cause.message : String(cause),
              gatePath: join(
                gateDirectory,
                `${role}-reconciliation-io.release`,
              ),
              timestamp: new Date().toISOString(),
            });
          } catch {
            // Preserve the original adapter failure if diagnostics also fail.
          }
          return { _tag: "ToolReconciliationError", cause };
        },
      });
    },
  };
  const shell = BUILTIN_EXECUTORS.find((executor) => executor.name === "shell");
  if (shell === undefined)
    throw new Error("AH7 test shell executor unavailable");
  const testShell = {
    ...shell,
    execute: (input) =>
      shell.execute(input).pipe(
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (outcome.settlement._tag !== "Success") return;
            const source = new DatabaseSync(databaseFile);
            try {
              const artifacts = source
                .prepare(
                  "SELECT artifact_id FROM artifacts WHERE kind = 'tool-result:read' ORDER BY created_at, artifact_id",
                )
                .all();
              const resultRef =
                artifacts[1]?.artifact_id ?? artifacts[0]?.artifact_id ?? null;
              source
                .prepare(
                  `INSERT INTO ah7_test_external_effects (effect_key, result_ref, recorded_at)
                   VALUES (?, ?, ?) ON CONFLICT(effect_key) DO NOTHING`,
                )
                .run(
                  effectKey(input.intent.invocationId),
                  resultRef,
                  new Date().toISOString(),
                );
            } finally {
              source.close();
            }
          }),
        ),
      ),
  };
  testReconciliationConfig = {
    profiles: [profile],
    port: testReconciliationPort,
    executors: BUILTIN_EXECUTORS.map((executor) =>
      executor.name === "shell" ? testShell : executor,
    ),
  };
}

const waitForGate = async (name, event) => {
  const gatePath = join(gateDirectory, `${role}-${name}.release`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `AH10 gate timed out: role=${role}, gate=${name}, event=${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({ tag: "AH10_PROBE", role, ...event })}\n`,
  );

const readActionKind = (logicalActionId) => {
  if (logicalActionId === undefined) return undefined;
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT action_kind FROM agent_loop_step_actions WHERE logical_action_id = ?",
      )
      .get(logicalActionId)?.action_kind;
  } finally {
    db.close();
  }
};

const qualificationProbe = async (event) => {
  if (
    role === "old" &&
    event.boundary === "AH7StaleDirectControlEffectSuppressed"
  ) {
    emit({ ...event, staleEffectSuppressed: true });
  }
  if (
    role === "old" &&
    event.actionIndex === 0 &&
    (event.boundary === "AH7AfterActionIntentCommit" ||
      event.boundary === "AH7BeforeActionResultCommit" ||
      event.boundary === "AH7AfterActionResultCommit" ||
      event.boundary === "AH9BeforeTerminalActionCommit" ||
      event.boundary === "AH9AfterTerminalActionCommit") &&
    process.env.ARBOR_AH10_CONTROL_EFFECT_BOUNDARY === event.boundary
  ) {
    const actionKind = event.actionKind;
    if (actionKind === process.env.ARBOR_AH10_CONTROL_EFFECT_KIND) {
      emit({ ...event, actionKind, controlEffectGate: true });
      await waitForGate("control-effect", event);
    }
  }
  if (
    event.boundary === "AH10AfterAssignWorkAuthorizedBeforeCommandSubmission"
  ) {
    const pauseRequested =
      process.env.ARBOR_AH10_PAUSE_AFTER_ASSIGN_WORK_AUTHORIZED === "1";
    emit({ ...event, pauseRequested });
    if (pauseRequested) await waitForGate("assign-work-authorized", event);
  }
  if (
    event.boundary === "AH10AfterControlHandlerReturnBeforeObservationCommit"
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    const gateActionKind = process.env.ARBOR_AH10_PAUSE_AFTER_CONTROL_KIND;
    if (
      process.env.ARBOR_AH10_PAUSE_AFTER_CONTROL_RETURN === "1" &&
      (gateActionKind === undefined || actionKind === gateActionKind)
    ) {
      emit({ ...event, actionKind });
      await waitForGate("control-return", event);
    }
  }
  if (
    event.boundary === "AH7AfterActionIntentCommit" &&
    event.actionIndex === 0
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    emit({ ...event, actionKind });
    const gateActionKind = process.env.ARBOR_AH10_GATE_ACTION_KIND;
    if (gateActionKind === undefined || actionKind === gateActionKind) {
      await waitForGate("action-intent", event);
      if (
        role === "old" &&
        process.env.ARBOR_AH10_EMIT_STALE_GATE_RELEASE === "1"
      ) {
        emit({
          ...event,
          boundary: "AH7ActionIntentGateReleased",
          actionKind,
          stage: "old-action-intent-gate-released",
        });
      }
    }
  }
  const reconciliationCrashBoundary = process.env.ARBOR_AH7_TEST_CRASH_BOUNDARY;
  if (
    reconciliationMode !== undefined &&
    event.boundary === reconciliationCrashBoundary &&
    (event.boundary === "AH7BeforeActionResultCommit" ||
      event.boundary === "AH7AfterActionResultCommit")
  ) {
    emit({ ...event, reconciliationProjectionProbe: true });
    process.stdout.write(`${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`);
    await waitForGate("test-reconciliation-crash", event);
  }
  if (
    role === "old" &&
    event.boundary === "AH9BeforeTerminalActionCommit" &&
    event.actionIndex === 0 &&
    process.env.ARBOR_AH10_PAUSE_BEFORE_TERMINAL_ACTION === "1"
  ) {
    const actionKind = readActionKind(event.logicalActionId);
    if (actionKind === process.env.ARBOR_AH10_GATE_ACTION_KIND) {
      emit({ ...event, actionKind });
      await waitForGate("terminal-action", event);
    }
  }
  if (
    role === "new" &&
    event.boundary === "AH7AfterActionResultCommit" &&
    event.actionIndex === 0
  ) {
    emit(event);
    await waitForGate("action-result", event);
  }
};

const executionLeaseQualificationProbe = async (event) => {
  if (event.boundary === "AH10AfterLeaseAcquired") emit(event);
  if (event.boundary === "AH10BeforeLeaseRenewal") {
    const delayedPause =
      role === "old" &&
      process.env.ARBOR_AH10_DELAY_LEASE_RENEWAL_PAUSE === "1";
    const pauseRequested = delayedPause
      ? existsSync(join(gateDirectory, "old-lease-renewal.pause"))
      : process.env.ARBOR_AH10_PAUSE_LEASE_RENEWAL === "1";
    emit({ ...event, pauseRequested });
    if (!pauseRequested) {
      return;
    }
    await waitForGate("lease-renewal", event);
  }
};

const executionSettlementQualificationProbe = async (event) => {
  const side =
    event.boundary === "AH10BeforeSubmittedDecisionBindingFactCommit"
      ? "before"
      : event.boundary === "AH10AfterSubmittedDecisionBindingFactCommit"
        ? "after"
        : undefined;
  if (
    side === undefined ||
    process.env.ARBOR_AH10_PAUSE_SUBMITTED_BINDING_FACT !== side
  ) {
    return;
  }
  emit(event);
  await waitForGate("submitted-binding-fact", event);
};

const submittedDecisionRecoveryQualificationProbe = (event) => {
  const targetExecutionId = process.env.ARBOR_AH10_P41_RECOVERY_EXECUTION_ID;
  if (
    targetExecutionId !== undefined &&
    targetExecutionId !== event.executionId
  ) {
    return;
  }
  const eventKey = `${event.executionId}:${event.boundary}:${event.stage ?? ""}:${event.outcome ?? ""}`;
  if (recoveryProbeEvents.has(eventKey)) return;
  recoveryProbeEvents.add(eventKey);
  emit({ ...event, recoveryProbe: true });
};

const gatewayQualificationProbe = async (event) => {
  if (
    role === "old" &&
    event.boundary === "AH10BeforeAssignWorkBindingCommit" &&
    process.env.ARBOR_AH10_PAUSE_BEFORE_ASSIGN_WORK_BINDING_COMMIT === "1"
  ) {
    emit(event);
    await waitForGate("assign-work-binding-commit", event);
    return;
  }
  if (role !== "old" || event.boundary !== "AH10BeforeFencedReceiptCommit") {
    return;
  }
  emit(event);
  if (process.env.ARBOR_AH10_PAUSE_BEFORE_FENCED_RECEIPT === "1") {
    await waitForGate("fenced-receipt", event);
  }
};

const toolQualificationProbe = async (event) => {
  if (reconciliationMode === undefined) return;
  emit({ ...event, runtimeProbe: true });
  const testCrashBoundary = process.env.ARBOR_AH7_TEST_CRASH_BOUNDARY;
  if (event.boundary === testCrashBoundary) {
    emit(event);
    process.stdout.write(`${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`);
    await waitForGate("test-reconciliation-crash", event);
    return;
  }
  if (event.boundary === "AH7AfterToolEffectBeforeSettlement") {
    emit(event);
    process.stdout.write(`${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`);
  }
  if (event.boundary === "AH7ReconciliationResultFenceRejected") {
    emit(event);
    process.stdout.write(`${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`);
    return;
  }
  if (
    event.boundary !== "AH7BeforeReconciliationFactCommit" &&
    event.boundary !== "AH7AfterReconciliationFactCommit"
  )
    return;
  const requested = process.env.ARBOR_AH7_TEST_RECONCILIATION_FACT_BOUNDARY;
  emit(event);
  process.stdout.write(`${JSON.stringify({ tag: "AH_PROBE", ...event })}\n`);
  if (event.boundary === requested) {
    await waitForGate("reconciliation-fact", event);
  }
};

const pauseAttentionBoundary = async (event) => {
  const requested = process.env.ARBOR_AH10_BINDING_ATTENTION_BOUNDARY;
  const side =
    event.boundary === "AH10BeforeAssignWorkBindingAttentionCommit"
      ? "before"
      : event.boundary === "AH10AfterAssignWorkBindingAttentionCommit"
        ? "after"
        : undefined;
  if (role !== "new" || side === undefined || requested !== side) return;
  emit(event);
  await waitForGate("binding-attention", event);
};

const port = Number(process.env.ARBOR_HTTP_PORT);
const config = {
  tickIntervalMs: 25,
  onWebTransportListening,
  startupDiagnosticProbe,
  ...(trustedHostConfigurationSource === undefined
    ? {}
    : { trustedHostConfigurationSource }),
  projectResourceProfiles,
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port,
    host: "127.0.0.1",
  },
  qualificationProbe,
  assignWorkAuthorizedBeforeCommandProbe: qualificationProbe,
  executionLeaseQualificationProbe,
  executionSettlementQualificationProbe,
  submittedDecisionRecoveryQualificationProbe,
  gatewayQualificationProbe,
  toolQualificationProbe,
  ...(testReconciliationConfig === undefined
    ? {}
    : { testOnlyToolReconciliation: testReconciliationConfig }),
  recoveryAttentionFactQualificationProbe: pauseAttentionBoundary,
  assignWorkBindingAttentionQualificationProbe: pauseAttentionBoundary,
};

const mainOverrides = {
  ...config,
  ...(trustedHostConfigurationSource === undefined
    ? {}
    : { trustedHostConfigurationSource }),
  ...(trustedHostConfigurationSource === undefined ? {} : { governance }),
};
const daemonLayer =
  process.env.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION === "1"
    ? functionalTestMain(mainOverrides, {
        allowTrustedLocalProcessExecution: true,
      })
    : main(mainOverrides);

await Effect.runPromise(
  Effect.provide(Effect.scoped(runDaemonForever(config)), daemonLayer),
);
