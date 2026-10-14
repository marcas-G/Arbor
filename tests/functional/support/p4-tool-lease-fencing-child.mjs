import { existsSync } from "node:fs";
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
import { Principal, parse } from "../../../packages/domain/dist/index.js";
import { runExecution } from "../../../packages/execution-runtime/dist/index.js";
import {
  BUILTIN_TOOLS,
  SHELL_DEFINITION,
} from "../../../packages/tool-runtime/dist/catalog.js";
import { createFunctionalDaemonListenReporter } from "./functional-daemon-lifecycle.mjs";

const onWebTransportListening = createFunctionalDaemonListenReporter();

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

if (process.env.ARBOR_P4_FENCE_NON_IDEMPOTENT === "1") {
  SHELL_DEFINITION.hash = "shell-v2-p4-lease-fencing";
  SHELL_DEFINITION.sideEffectSemantics = "NonIdempotent";
}

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
    role === "old" &&
    event.boundary === process.env.ARBOR_P4_FENCE_ADMISSION_BOUNDARY
  ) {
    emit(event);
    await waitForGate("tool-admission", event);
    return;
  }
  if (
    role === "old" &&
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

const executionLeaseQualificationProbe = async (event) => {
  if (
    role === "old" &&
    event.boundary === "AH10BeforeLeaseAcquired" &&
    process.env.ARBOR_P4_FENCE_PAUSE_OLD_ACQUIRE === "1" &&
    existsSync(join(gateDirectory, "old-acquire.request"))
  ) {
    emit({
      boundary: "AH10BeforeLeaseAcquiredPaused",
      executionId: event.executionId,
    });
    await waitForGate("old-acquire", event);
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
  if (role === "old" && event.toolName === "shell") {
    emit(event);
  }
};

const p39RecoveryBindingQualificationProbe = async (event) => {
  if (role === "old") emit(event);
};
const port = Number(process.env.ARBOR_HTTP_PORT);
const config = {
  tickIntervalMs: 25,
  projectResourceProfiles: makeProjectResourceProfilePort(
    projectResourceProfilesFromEnvironment(),
  ),
  webTransport: {
    staticRoot: process.env.ARBOR_WEB_DIST,
    port,
    host: "127.0.0.1",
  },
  onWebTransportListening,
  toolQualificationProbe,
  executableToolQualificationProbe,
  p39RecoveryBindingQualificationProbe,
  executionLeaseQualificationProbe,
  schedulerQualificationProbe,
};

if (role === "new" && explicitExecutionTarget !== undefined) {
  void (async () => {
    await waitForGate("explicit-runExecution", {
      executionId: explicitExecutionTarget,
    });
    explicitExecutionIds.add(explicitExecutionTarget);
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
          main(config),
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
    Effect.provide(Effect.scoped(runDaemonForever(config)), main(config)),
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
