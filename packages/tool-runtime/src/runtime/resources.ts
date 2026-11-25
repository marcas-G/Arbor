import type { ResourceAddress, Workspace } from "@arbor/domain";
import type {
  CanonicalToolObservation,
  EnvironmentRevisionStoreService,
  ProjectEnvironmentPortService,
  ResourceAdmissionService,
  ToolDefinition,
  ToolExecutionContext,
  ToolIntent,
  ToolInvocationRecord,
  ToolRuntimeError,
  TransactionPortService,
  WorkspaceRepositoryService,
} from "@arbor/ports";
import { Effect, Option } from "effect";
import {
  type FilesystemAddress,
  legacyResourceArguments,
  primaryFilesystemAddress,
  requestedFilesystemTarget,
  requestedMountRefs,
} from "../requested-resources.js";
import {
  isP39ResourceResolutionStale,
  operationalFailure,
  P39_RESOURCE_RESOLUTION_STALE,
} from "./errors.js";
import type { makeNoEffectSettlement } from "./no-effect-settlement.js";
import type { ToolExecutor } from "./types.js";

/** Capture workspace/environment resource identity and return scoped revalidation functions. */
export const resolveInvocationResources = (
  intent: ToolIntent,
  context: ToolExecutionContext,
  definition: ToolDefinition,
  executor: ToolExecutor,
  tx: TransactionPortService,
  workspaces: Option.Option<WorkspaceRepositoryService>,
  environment: ProjectEnvironmentPortService,
  environmentRevisions: Option.Option<EnvironmentRevisionStoreService>,
  admission: ResourceAdmissionService,
  p39BindingEnabled: boolean,
  priorModelIdentityMatches: boolean,
  priorRecord: ToolInvocationRecord | undefined,
  hasVerifiedReplayBinding: boolean,
  recordNoEffectDenial: ReturnType<typeof makeNoEffectSettlement>["recordNoEffectDenial"],
  refreshAfterStale: (cause: unknown) => Effect.Effect<CanonicalToolObservation, ToolRuntimeError>,
) =>
  Effect.gen(function* () {
    const mountRefs = requestedMountRefs(intent.argumentsJson);
    let address: FilesystemAddress | undefined;
    let addresses: ReadonlyArray<ResourceAddress>;
    let boundaryWorkspace: Workspace | undefined;
    if (mountRefs.length > 0) {
      if (
        mountRefs.length !== 1 ||
        mountRefs.some((mount) => mount !== "workspace")
      ) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      if (Option.isNone(workspaces)) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      const workspace = yield* tx
        .transact(workspaces.value.findById(context.workspaceId))
        .pipe(
          Effect.mapError(
            operationalFailure(
              "WorkspaceLookup",
              String(intent.invocationId),
            ),
          ),
        );
      if (Option.isNone(workspace)) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      boundaryWorkspace = workspace.value;
      address = primaryFilesystemAddress(
        workspace.value.resourceBoundary.addresses,
      );
      if (address === undefined) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      const exactTarget =
        executor.processCapability !== "SandboxProcess" &&
        ["read", "list", "patch", "write", "glob", "grep"].includes(
          intent.toolName,
        )
          ? requestedFilesystemTarget(intent.argumentsJson, address)
          : ({ _tag: "Absent" } as const);
      if (exactTarget._tag === "Invalid") {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      addresses = [
        exactTarget._tag === "Address" ? exactTarget.address : address,
      ];
    } else {
      addresses = legacyResourceArguments(intent.argumentsJson);
    }
    if (boundaryWorkspace === undefined) {
      if (Option.isNone(workspaces)) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      const workspace = yield* tx
        .transact(workspaces.value.findById(context.workspaceId))
        .pipe(
          Effect.mapError(
            operationalFailure(
              "WorkspaceLookup",
              String(intent.invocationId),
            ),
          ),
        );
      if (
        Option.isNone(workspace) ||
        workspace.value.projectId !== context.projectId
      ) {
        return {
          _tag: "Terminal" as const,
          observation: yield* recordNoEffectDenial(
          definition.sideEffectSemantics,
          [],
          "ResourceResolutionDenied",
          ),
        };
      }
      boundaryWorkspace = workspace.value;
    }
    const capturedWorkspace = boundaryWorkspace;
    if (capturedWorkspace.projectId !== context.projectId) {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
        definition.sideEffectSemantics,
        [],
        "ResourceResolutionDenied",
        ),
      };
    }
    const resolved = yield* environment
      .resolve(context.projectId, addresses)
      .pipe(
        Effect.mapError(
          operationalFailure(
            "EnvironmentResolution",
            String(intent.invocationId),
          ),
        ),
      );
    const resolvedBoundary = yield* environment
      .resolve(
        context.projectId,
        capturedWorkspace.resourceBoundary.addresses,
      )
      .pipe(
        Effect.mapError(
          operationalFailure(
            "EnvironmentResolution",
            String(intent.invocationId),
          ),
        ),
      );
    if (
      resolved.observedEnvironmentRevision !==
      resolvedBoundary.observedEnvironmentRevision
    ) {
      return {
          _tag: "Terminal" as const,
          observation: yield* refreshAfterStale({
        _tag: "ResourceResolutionStale",
        observed: resolved.observedEnvironmentRevision,
        boundaryObserved: resolvedBoundary.observedEnvironmentRevision,
      });
    }
    const regions =
      priorModelIdentityMatches &&
      priorRecord !== undefined &&
      ((priorRecord.settlement === null &&
        priorRecord.effectAdmissionState === "NotAdmitted") ||
        priorRecord.settlement?._tag === "Interrupted")
        ? priorRecord.resolvedRegions
        : resolved.regions;
    const boundaryRegions = resolvedBoundary.regions;
    const validateCapturedSnapshot = () =>
      Effect.gen(function* () {
        if (Option.isNone(workspaces)) {
          return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
        }
        const currentWorkspace = yield* workspaces.value.findById(
          context.workspaceId,
          ),
        };
        if (
          Option.isNone(currentWorkspace) ||
          currentWorkspace.value.projectId !== context.projectId ||
          currentWorkspace.value.resourceBoundaryRevision !==
            capturedWorkspace.resourceBoundaryRevision ||
          JSON.stringify(
            currentWorkspace.value.resourceBoundary.addresses,
          ) !==
            JSON.stringify(capturedWorkspace.resourceBoundary.addresses)
        ) {
          return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
        }
        if (p39BindingEnabled) {
          if (Option.isNone(environmentRevisions)) {
            return yield* Effect.fail<ToolRuntimeError>(
              operationalFailure(
                "RecoveryBinding",
                String(intent.invocationId),
              )({ _tag: "EnvironmentRevisionStoreUnavailable" }),
            );
          }
          const currentEnvironment = yield* environmentRevisions.value
            .current(context.projectId)
            .pipe(
              Effect.mapError(
                operationalFailure(
                  "RecoveryBinding",
                  String(intent.invocationId),
                ),
              ),
            );
          if (
            (Option.isSome(currentEnvironment) &&
              currentEnvironment.value !==
                resolved.observedEnvironmentRevision) ||
            (Option.isNone(currentEnvironment) &&
              resolved.observedEnvironmentRevision !== "0")
          ) {
            return yield* Effect.fail(P39_RESOURCE_RESOLUTION_STALE);
          }
        }
        return undefined;
      });
    const validateCapturedSnapshotAndAdmit = () =>
      Effect.gen(function* () {
        yield* validateCapturedSnapshot();
        return yield* admission.admit({
          workspaceId: context.workspaceId,
          regions,
          resolvedBoundaryRegions: boundaryRegions,
          write: executor.write,
        });
      });
    const checkCapturedSnapshotAndAdmit = () =>
      tx
        .transact(validateCapturedSnapshotAndAdmit())
        .pipe(
          Effect.mapError((cause) =>
            isP39ResourceResolutionStale(cause)
              ? cause
              : operationalFailure(
                  "ResourceAdmission",
                  String(intent.invocationId),
                )(cause),
          ),
        );
    const region = regions[0];
    if (
      address !== undefined &&
      (region === undefined || regions.length !== 1) &&
      !hasVerifiedReplayBinding
    ) {
      return {
        _tag: "Terminal" as const,
        observation: yield* recordNoEffectDenial(
        definition.sideEffectSemantics,
        [],
        "ResourceResolutionDenied",
        ),
      };
    }

    return {
      _tag: "Ready" as const,
      address,
      capturedWorkspace,
      resolved,
      regions,
      boundaryRegions,
      validateCapturedSnapshot,
      validateCapturedSnapshotAndAdmit,
      checkCapturedSnapshotAndAdmit,
      region,
    };
  });
