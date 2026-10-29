import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import {
  main,
  runDaemonForever,
} from "../../../apps/single-workspace/dist/main.js";
import {
  makeProjectResourceProfilePort,
  projectResourceProfilesFromEnvironment,
} from "../../../apps/single-workspace/dist/project-resource-profiles.js";
import {
  Principal,
  parse,
  WorkspaceId,
} from "../../../packages/domain/dist/index.js";
import { runExecution } from "../../../packages/execution-runtime/dist/index.js";
import {
  BUILTIN_TOOLS,
  SHELL_DEFINITION,
} from "../../../packages/tool-runtime/dist/catalog.js";
import { BUILTIN_EXECUTORS } from "../../../packages/tool-runtime/dist/index.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";
import { functionalTestMain } from "./functional-test-composition.mjs";

const onWebTransportListening = createFunctionalDaemonListenReporter();
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

const role = process.env.ARBOR_P4_FENCE_ROLE;
if (role !== "old" && role !== "new") {
  throw new Error("P4 fencing child needs role=old|new");
}
const databaseFile = process.env.ARBOR_DB;
if (databaseFile === undefined) {
  throw new Error("P4 fencing child needs ARBOR_DB");
}
const gateDirectory = join(dirname(databaseFile), "p4-fence-gates");
const explicitExecutionTarget =
  process.env.ARBOR_P4_FENCE_EXPLICIT_EXECUTION_ID;
const targetWorkspaceId = process.env.ARBOR_P4_FENCE_TARGET_WORKSPACE_ID;
const targetWorkId = process.env.ARBOR_P4_FENCE_TARGET_WORK_ID;
const explicitExecutionIds = new Set();
const reportedLiveLeaseSkips = new Set();
let schedulerDiagnosticCount = 0;

const emit = (event) =>
  process.stdout.write(
    `${JSON.stringify({
      tag: "P4_FENCE_PROBE",
      role,
      pid: process.pid,
      observedAt: new Date().toISOString(),
      ...event,
    })}\n`,
  );

const waitForGate = async (name, event) => {
  const gatePath = join(gateDirectory, `${role}-${name}.release`);
  const deadline = Date.now() + 120_000;
  while (!existsSync(gatePath)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `P4 fencing gate timed out: role=${role}, gate=${name}, event=${JSON.stringify(event)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const nonIdempotentProfile = process.env.ARBOR_P4_FENCE_NON_IDEMPOTENT === "1";
const reconcilableProfile = process.env.ARBOR_P4_FENCE_RECONCILABLE === "1";
if (nonIdempotentProfile && reconcilableProfile) {
  throw new Error(
    "P4 fencing child cannot enable both test-only shell profiles",
  );
}
if (nonIdempotentProfile) {
  SHELL_DEFINITION.hash = "shell-v2-p4-lease-fencing";
  SHELL_DEFINITION.sideEffectSemantics = "NonIdempotent";
}
if (reconcilableProfile) {
  SHELL_DEFINITION.hash = "shell-v3-p4-fence-test-reconcilable";
  SHELL_DEFINITION.sideEffectSemantics = "Reconcilable";
}

const reconciliationAuditPath = join(
  gateDirectory,
  "reconciliation-port-calls.jsonl",
);
if (reconcilableProfile) mkdirSync(gateDirectory, { recursive: true });
const testOnlyToolReconciliation = reconcilableProfile
  ? (() => {
      const profile = {
        toolName: "shell",
        toolVersion: SHELL_DEFINITION.version,
        toolDefinitionHash: SHELL_DEFINITION.hash,
        profileId: "p4-fence-test-reconciliation",
        profileVersion: "1",
        profileHash: createHash("sha256")
          .update("arbor-p4-fence-test-reconciliation-v1")
          .digest("hex"),
        profileProtocol: "p4-fence-test-reconciliation-v1",
        effectKey: ({ invocationId }) => `p4-fence-test:${invocationId}`,
        reconstructOccurred: () => null,
      };
      return {
        profiles: [profile],
        port: {
          reconcile: (request) => {
            appendFileSync(
              reconciliationAuditPath,
              `${JSON.stringify({
                role,
                invocationId: request.invocationId,
                attemptNo: request.attemptNo,
                result: "StillUnknown",
                reasonCode: "AttemptNotFinal",
              })}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            return Effect.succeed({
              _tag: "StillUnknown",
              reasonCode: "AttemptNotFinal",
              evidenceRef: null,
            });
          },
        },
        executors: BUILTIN_EXECUTORS,
        snapshot: {
          toolName: profile.toolName,
          toolVersion: profile.toolVersion,
          toolDefinitionHash: profile.toolDefinitionHash,
          profileId: profile.profileId,
          profileVersion: profile.profileVersion,
          profileHash: profile.profileHash,
          profileProtocol: profile.profileProtocol,
          effectKey: profile.effectKey({
            invocationId: "tinv_p4_fence_profile_probe",
            argumentsJson: "{}",
          }),
        },
      };
    })()
  : undefined;

emit({
  boundary: "P4TestReconciliationRegistrySnapshot",
  registered: testOnlyToolReconciliation !== undefined,
  ...(testOnlyToolReconciliation === undefined
    ? {}
    : { profile: testOnlyToolReconciliation.snapshot }),
});

emit({
  boundary: "P4ShellDefinitionSnapshot",
  definition: {
    name: SHELL_DEFINITION.name,
    version: SHELL_DEFINITION.version,
    hash: SHELL_DEFINITION.hash,
    sideEffectSemantics: SHELL_DEFINITION.sideEffectSemantics,
    capabilityMetadata: SHELL_DEFINITION.capabilityMetadata,
    source: SHELL_DEFINITION.source,
  },
});
emit({
  boundary: "P4BuiltinCatalogSnapshot",
  definitionCount: BUILTIN_TOOLS.length,
  definitionsTruncated: BUILTIN_TOOLS.length > 32,
  definitions: BUILTIN_TOOLS.slice(0, 32).map((definition) => ({
    name: definition.name,
    version: definition.version,
    hash: definition.hash,
    sideEffectSemantics: definition.sideEffectSemantics,
    source: definition.source,
  })),
});

const toolQualificationProbe = async (event) => {
  if (
    process.env.ARBOR_P4_P39_BEGIN_GATE === "1" &&
    event.boundary === "P38P39ClaimBeforeTransaction"
  ) {
    const target = JSON.parse(
      readFileSync(join(gateDirectory, "p4-p39-target.json"), "utf8"),
    );
    if (
      event.executionId === target.executionId &&
      event.invocationId === target.invocationId &&
      event.approvalId === target.approvalId
    ) {
      p39BeginGateArmed = true;
      emit(event);
    }
    return;
  }
  if (
    role === "old" &&
    event.boundary === process.env.ARBOR_P4_FENCE_ADMISSION_BOUNDARY
  ) {
    emit(event);
    await waitForGate("tool-admission", event);
    return;
  }
  if (
    (role === "old" ||
      (role === "new" && process.env.ARBOR_P4_FENCE_TRACE_NEW === "1")) &&
    [
      "AH7AfterToolIntentCommit",
      "AH7AfterEffectAuthorityResolvedBeforeAdmission",
      "AH7BeforeEffectAdmission",
      "AH7AfterEffectAdmissionCommit",
      "AH7AfterToolEffectBeforeSettlement",
      "AH7BeforeToolSettlementTransaction",
      "AH7BeforeToolSettlementCommit",
      "AH7AfterToolSettlementCommit",
      "AH7ToolSettlementFenceRejected",
      "P38StopInvocationLookup",
      "P38StopEffectAdmissionResult",
    ].includes(event.boundary)
  ) {
    emit(event);
  }
  if (
    role === "old" &&
    event.boundary === "AH7AfterToolEffectBeforeSettlement"
  ) {
    await waitForGate("tool-effect", event);
    return;
  }
};

let approvalTtlPauseTaken = false;
const executableApprovalExpiryQualificationProbe = async (event) => {
  const race = process.env.ARBOR_P4_STOP_TTL_RACE;
  if (race === undefined) return;
  if (
    ((role === "old" &&
      (race === "stop-wins" || race === "ttl-main-blocked")) ||
      (role === "new" && race === "ttl-worker")) &&
    event.boundary === "P38BeforeExecutableApprovalExpiryTransaction" &&
    !approvalTtlPauseTaken &&
    existsSync(join(gateDirectory, "ttl-before.request"))
  ) {
    approvalTtlPauseTaken = true;
    emit({ ...event, boundary: "P38TTLBeforeExpiryTransaction" });
    await waitForGate("ttl-before", event);
    return;
  }
  if (
    event.boundary === "P38AfterExecutableApprovalExpiryMutationBeforeCommit"
  ) {
    emit({ ...event, boundary: "P38TTLAfterExpiryScanBeforeCommit" });
  }
};

const gatewayQualificationProbe = async (event) => {
  const race = process.env.ARBOR_P4_STOP_TTL_RACE;
  if (
    role !== "old" ||
    race === undefined ||
    (event.boundary !== "P38StopExecutionBeforeTransaction" &&
      event.boundary !== "P38StopExecutionBeforeCommit")
  ) {
    return;
  }
  emit(event);
  if (
    race === "stop-wins" &&
    event.boundary === "P38StopExecutionBeforeCommit" &&
    existsSync(join(gateDirectory, "stop-commit.request"))
  ) {
    await waitForGate("stop-commit", event);
  }
};

const executionLeaseQualificationProbe = async (event) => {
  if (
    role === "old" &&
    event.boundary === "AH10BeforeLeaseAcquired" &&
    process.env.ARBOR_P4_FENCE_PAUSE_OLD_ACQUIRE === "1" &&
    existsSync(join(gateDirectory, "old-acquire.request"))
  ) {
    emit({
      boundary: "AH10BeforeLeaseAcquiredReady",
      executionId: event.executionId,
    });
    await waitForGate("acquire", event);
    return;
  }
  if (event.boundary === "AH10LeaseAcquisitionRejected") {
    emit({
      ...event,
      source: explicitExecutionIds.has(event.executionId)
        ? "test-runExecution"
        : "scheduler",
    });
    return;
  }
  if (event.boundary === "AH10PreDispatchSkippedLiveLease") {
    if (!reportedLiveLeaseSkips.has(event.executionId)) {
      reportedLiveLeaseSkips.add(event.executionId);
      emit(event);
    }
    return;
  }
  if (event.boundary === "AH10AfterLeaseAcquired") {
    emit(event);
    if (role === "new" && process.env.ARBOR_P4_FENCE_PAUSE_NEW === "1") {
      await waitForGate("new-driver", event);
    } else if (
      role === "old" &&
      existsSync(join(gateDirectory, "old-driver.request"))
    ) {
      await waitForGate("old-driver", event);
    }
    return;
  }
  if (role === "old" && event.boundary === "AH10BeforeLeaseRenewal") {
    const pauseRenewal = existsSync(
      join(gateDirectory, "old-freeze-renewal.request"),
    );
    if (
      pauseRenewal ||
      process.env.ARBOR_P4_LEASE_RENEWAL_DIAGNOSTICS === "1"
    ) {
      emit(event);
    }
    if (pauseRenewal) await waitForGate("old-renewal", event);
  }
};

const schedulerQualificationProbe = (event) => {
  const targetExecutionId = explicitExecutionTarget;
  if (
    process.env.ARBOR_P4_SCHEDULER_DIAGNOSTICS !== "1" ||
    role !== "new" ||
    targetExecutionId === undefined ||
    schedulerDiagnosticCount >= 256
  ) {
    return;
  }
  schedulerDiagnosticCount += 1;
  const candidateExecutionId =
    event.candidate?.executionId ?? event.executionId;
  const selectionRejectionReason =
    event.boundary === "WorkspaceScanComplete" &&
    targetWorkspaceId !== undefined &&
    !event.workspaceIds?.includes(targetWorkspaceId)
      ? "TargetWorkspaceNotScanned"
      : event.boundary !== "ActiveCandidateSummary"
        ? undefined
        : candidateExecutionId === undefined
          ? (event.selectionRejectionReason ?? "NoActiveMainExecution")
          : event.workspaceId !== targetWorkspaceId
            ? "DifferentWorkspaceCandidate"
            : candidateExecutionId !== targetExecutionId
              ? "DifferentActiveExecutionSelected"
              : targetWorkId !== undefined &&
                  event.candidate?.workId !== targetWorkId
                ? "TargetWorkNotBoundToSelectedExecution"
                : event.candidate?.currentWorkMatchesEpisode === false
                  ? "TargetWorkNotCurrent"
                  : undefined;
  process.stdout.write(
    `${JSON.stringify({
      tag: "P4_SCHEDULER_PROBE",
      role,
      pid: process.pid,
      targetExecutionId,
      targetWorkspaceId,
      targetWorkId,
      candidateExecutionId,
      matchesTargetExecution: candidateExecutionId === targetExecutionId,
      ...(selectionRejectionReason !== undefined
        ? { selectionRejectionReason }
        : {}),
      ...event,
    })}\n`,
  );
};

const executableToolQualificationProbe = async (event) => {
  if (
    event.toolName === "shell" &&
    (role === "old" ||
      (role === "new" && process.env.ARBOR_P4_FENCE_TRACE_NEW === "1"))
  ) {
    emit(event);
    if (
      role === "old" &&
      process.env.ARBOR_P4_FENCE_ADMISSION_BOUNDARY ===
        "P4ExecutableToolRuntimeOutcomeDenied" &&
      event.boundary === "P4ExecutableToolRuntimeOutcome" &&
      event.outcomeTag === "Denied"
    ) {
      await waitForGate("tool-admission", event);
    }
  }
};

let p39BeginGateArmed = false;
const p39RecoveryBindingQualificationProbe = async (event) => {
  if (role !== "old") return;
  if (
    event.boundary ===
    (process.env.ARBOR_P4_P39_BINDING_BOUNDARY ??
      process.env.ARBOR_P4_FENCE_ADMISSION_BOUNDARY)
  ) {
    emit(event);
    await waitForGate("p39-claim", event);
    return;
  }
  emit(event);
};
let p39BeginGateTaken = false;
const transactionBeginQualificationProbe = async (event) => {
  if (
    process.env.ARBOR_P4_P39_BEGIN_GATE !== "1" ||
    !p39BeginGateArmed ||
    p39BeginGateTaken ||
    !existsSync(join(gateDirectory, "p4-p39-target.json"))
  ) {
    return;
  }
  p39BeginGateTaken = true;
  emit({
    boundary: "P38P39BeforeBegin",
    transactionBoundary: event.boundary,
  });
  await waitForGate("p39-begin", event);
};
const port = Number(process.env.ARBOR_HTTP_PORT);
const config = {
  tickIntervalMs: 25,
  ...(process.env.ARBOR_WORKSPACE_ID !== undefined
    ? { workspaceId: parse(WorkspaceId)(process.env.ARBOR_WORKSPACE_ID) }
    : {}),
  projectResourceProfiles: makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment(),
  ),
  ...(testOnlyToolReconciliation === undefined
    ? {}
    : { testOnlyToolReconciliation }),
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port,
    host: "127.0.0.1",
  },
  onWebTransportListening,
  ...(trustedHostConfigurationSource === undefined
    ? {}
    : { trustedHostConfigurationSource }),
  toolQualificationProbe,
  executableToolQualificationProbe,
  p39RecoveryBindingQualificationProbe,
  executionLeaseQualificationProbe,
  schedulerQualificationProbe,
  gatewayQualificationProbe,
  executableApprovalExpiryQualificationProbe,
  ...(process.env.ARBOR_P4_P39_BEGIN_GATE === "1"
    ? { transactionBeginQualificationProbe }
    : {}),
};
const mainOverrides = {
  ...config,
  ...(trustedHostConfigurationSource === undefined
    ? {}
    : { trustedHostConfigurationSource }),
  ...(trustedHostConfigurationSource === undefined ? {} : { governance }),
};
const makeDaemonLayer = () =>
  process.env.ARBOR_TEST_ONLY_TRUSTED_LOCAL_PROCESS_EXECUTION === "1"
    ? functionalTestMain(mainOverrides, {
        allowTrustedLocalProcessExecution: true,
      })
    : main(mainOverrides);

if (role === "new" && explicitExecutionTarget !== undefined) {
  void (async () => {
    await waitForGate("explicit-runExecution", {
      executionId: explicitExecutionTarget,
    });
    explicitExecutionIds.add(explicitExecutionTarget);
    emit({
      boundary: "P4ExplicitRunExecutionStart",
      executionId: explicitExecutionTarget,
    });
    try {
      await Effect.runPromise(
        Effect.provide(
          runExecution(
            explicitExecutionTarget,
            { _tag: "Recovery" },
            parse(Principal)("runtime:system"),
            undefined,
            undefined,
            executionLeaseQualificationProbe,
          ),
          makeDaemonLayer(),
        ),
      );
      emit({
        boundary: "AH10ExplicitRunExecutionUnexpectedSuccess",
        executionId: explicitExecutionTarget,
      });
    } catch (error) {
      const errorText = `${String(error)} ${JSON.stringify(error)}`;
      if (!errorText.includes("LeaseFencingRejected")) {
        emit({
          boundary: "AH10ExplicitRunExecutionError",
          executionId: explicitExecutionTarget,
          error: errorText,
        });
      }
    }
  })().catch((error) => {
    emit({
      boundary: "AH10ExplicitRunExecutionError",
      executionId: explicitExecutionTarget,
      error: String(error),
    });
  });
}

emit({ boundary: "P4ChildBeforeDaemonMain" });
try {
  await Effect.runPromise(
    Effect.provide(Effect.scoped(runDaemonForever(config)), makeDaemonLayer()),
  );
  emit({ boundary: "P4ChildDaemonMainResolved" });
} catch (error) {
  const errorObject =
    typeof error === "object" && error !== null ? error : undefined;
  const stack = error instanceof Error ? error.stack : undefined;
  const errorName =
    errorObject !== undefined &&
    "name" in errorObject &&
    typeof errorObject.name === "string"
      ? errorObject.name
      : "Unknown";
  const sourceTag =
    errorObject !== undefined &&
    "_tag" in errorObject &&
    typeof errorObject._tag === "string"
      ? errorObject._tag
      : undefined;
  emit({
    boundary: "P4ChildDaemonMainRejected",
    errorName,
    ...(sourceTag === undefined ? {} : { sourceTag }),
    ...(stack === undefined
      ? {}
      : { stackTail: stack.split("\n").slice(-8).join("\n").slice(-1600) }),
  });
  throw error;
}
