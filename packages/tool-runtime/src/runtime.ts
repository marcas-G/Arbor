import type { CanonicalResourceRegion, ResourceAddress } from "@arbor/domain";
import {
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  type SandboxHandle,
  SandboxPort,
  ToolAuthorityResolver,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";
import { matchApproval } from "./approval.js";
import { checkInvocationAuthority } from "./authority.js";
import { validateToolInput } from "./validation.js";

export interface ToolExecutionResult {
  readonly settlement: ToolInvocationSettlement;
  readonly observation: BoundedObservation;
  readonly resultRef: string | null;
}

export interface ToolExecutor {
  readonly name: string;
  readonly write: boolean;
  readonly requiresApproval: (intent: ToolIntent) => boolean;
  readonly execute: (input: {
    readonly intent: ToolIntent;
    readonly definition: ToolDefinition;
    readonly context: ToolExecutionContext;
    readonly sandbox: SandboxHandle;
    readonly regions: ReadonlyArray<CanonicalResourceRegion>;
  }) => Effect.Effect<ToolExecutionResult, ToolRuntimeError>;
}

const bounded = (text: string, limit = 2000): BoundedObservation => ({
  text: text.length > limit ? text.slice(0, limit) : text,
  truncated: text.length > limit,
});

const requestedMountRefs = (argumentsJson: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      target?: { readonly mount?: unknown };
      cwd?: { readonly mount?: unknown };
    };
    return [parsed.target?.mount, parsed.cwd?.mount].filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
};

const legacyResourceArguments = (
  argumentsJson: string,
): ReadonlyArray<ResourceAddress> => {
  try {
    const parsed = JSON.parse(argumentsJson) as {
      path?: ResourceAddress;
      cwd?: ResourceAddress;
    };
    return [parsed.path, parsed.cwd].filter(
      (value): value is ResourceAddress => value !== undefined,
    );
  } catch {
    return [];
  }
};

type FilesystemAddress = Extract<
  ResourceAddress,
  { readonly _tag: "FileTree" | "GitWorktree" }
>;

const primaryFilesystemAddress = (
  addresses: ReadonlyArray<ResourceAddress>,
): FilesystemAddress | undefined => {
  const candidates = addresses.filter(
    (address): address is FilesystemAddress =>
      address._tag === "GitWorktree" || address._tag === "FileTree",
  );
  const paths = new Set(
    candidates.map((address) =>
      address.path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
    ),
  );
  if (paths.size !== 1) return undefined;
  return (
    candidates.find((address) => address._tag === "GitWorktree") ??
    candidates[0]
  );
};

const denied = (reason: string): CanonicalToolObservation => ({
  _tag: "Denied",
  reason,
});

export const ToolRuntimeLive = (
  executors: ReadonlyArray<ToolExecutor>,
  options: { readonly maxDelegationDepth?: number; readonly now?: string } = {},
): Layer.Layer<
  ToolRuntimePort,
  never,
  | ToolDefinitionStore
  | SandboxPort
  | ResourceAdmission
  | ToolInvocationStore
  | ProjectEnvironmentPort
  | TransactionPort
  | Clock
> =>
  Layer.effect(
    ToolRuntimePort,
    Effect.gen(function* () {
      const definitions = yield* ToolDefinitionStore;
      const sandbox = yield* SandboxPort;
      const admission = yield* ResourceAdmission;
      const store = yield* ToolInvocationStore;
      const tx = yield* TransactionPort;
      const clock = yield* Clock;
      const environment = yield* ProjectEnvironmentPort;
      const workspaces = yield* Effect.serviceOption(WorkspaceRepository);
      const authorityResolver = yield* Effect.serviceOption(
        ToolAuthorityResolver,
      );

      const failure = (cause: unknown): ToolRuntimeError => ({
        _tag: "ToolRuntimeError",
        cause,
      });

      const invoke = (intent: ToolIntent, context: ToolExecutionContext) =>
        Effect.gen(function* () {
          const definitionOption = yield* definitions.definition(
            intent.toolName,
            intent.toolVersion,
          );
          if (Option.isNone(definitionOption)) {
            return denied("unknown tool");
          }
          const definition = definitionOption.value;
          const executor = executors.find(
            (entry) => entry.name === intent.toolName,
          );
          if (executor === undefined) {
            return denied("no executor for tool");
          }

          const validation = validateToolInput(
            definition.inputSchemaJson,
            intent.argumentsJson,
          );
          if (validation._tag === "Invalid") {
            return {
              _tag: "ExpectedFailure" as const,
              observation: bounded(validation.reason),
            };
          }

          const now = options.now ?? (yield* clock.now());
          const mountRefs = requestedMountRefs(intent.argumentsJson);
          let address: FilesystemAddress | undefined;
          let addresses: ReadonlyArray<ResourceAddress>;
          if (mountRefs.length > 0) {
            if (
              mountRefs.length !== 1 ||
              mountRefs.some((mount) => mount !== "workspace")
            ) {
              return denied("tool target must reference the workspace mount");
            }
            if (Option.isNone(workspaces)) {
              return denied("workspace mount resolver unavailable");
            }
            const workspace = yield* tx.transact(
              workspaces.value.findById(context.workspaceId),
            );
            if (Option.isNone(workspace)) {
              return denied("workspace not found");
            }
            address = primaryFilesystemAddress(
              workspace.value.resourceBoundary.addresses,
            );
            if (address === undefined) {
              return denied(
                "workspace filesystem mount is missing or ambiguous",
              );
            }
            addresses = [address];
          } else {
            addresses = legacyResourceArguments(intent.argumentsJson);
          }
          const resolved = yield* environment.resolve(
            context.projectId,
            addresses,
          );
          const regions = resolved.regions;
          const region = regions[0];
          if (
            address !== undefined &&
            (region === undefined || regions.length !== 1)
          ) {
            return denied(
              "workspace filesystem region is unresolved or ambiguous",
            );
          }

          const resolvedAuthority = Option.isSome(authorityResolver)
            ? yield* authorityResolver.value.resolve({
                intent,
                definition,
                context,
                regions,
                now,
              })
            : context.authority;
          if (resolvedAuthority === undefined) {
            return denied("tool authority unavailable");
          }
          const authority = checkInvocationAuthority({
            authority: resolvedAuthority,
            definition,
            intent,
            context,
            regions,
            now,
            maxDelegationDepth: options.maxDelegationDepth ?? 1,
          });
          if (authority._tag === "Denied") {
            return denied(authority.reason);
          }

          const needsApproval = executor.requiresApproval(intent);
          if (needsApproval) {
            if (intent.approvalId === null) {
              return denied("approval required");
            }
            const approval = yield* tx.transact(
              store.findApproval(intent.approvalId),
            );
            if (Option.isNone(approval)) {
              return denied("approval not found");
            }
            const matched = matchApproval({
              approval: approval.value,
              intent,
              definition,
              context,
              regions,
              now,
            });
            if (matched._tag === "Denied") {
              return denied(matched.reason);
            }
          }

          const admitted = yield* tx.transact(
            admission.admit({
              workspaceId: context.workspaceId,
              regions,
              write: executor.write,
            }),
          );
          if (admitted._tag === "Denied") {
            return denied(admitted.reason);
          }

          yield* tx.transact(
            store.recordIntent({
              invocationId: intent.invocationId,
              executionId: context.executionId,
              workspaceId: context.workspaceId,
              toolName: intent.toolName,
              toolVersion: intent.toolVersion,
              sideEffectSemantics: definition.sideEffectSemantics,
              argumentsJson: intent.argumentsJson,
              resolvedRegions: regions,
              approvalId: intent.approvalId,
              intentAt: now,
            }),
          );
          if (needsApproval && intent.approvalId !== null) {
            const consumed = yield* tx.transact(
              store.consumeApproval(intent.approvalId, intent.invocationId),
            );
            if (!consumed) {
              return denied("approval already consumed");
            }
          }

          const handle = yield* sandbox.open(
            address === undefined || region === undefined
              ? {
                  executionId: context.executionId,
                  workspaceId: context.workspaceId,
                  regions,
                }
              : {
                  executionId: context.executionId,
                  workspaceId: context.workspaceId,
                  mounts: [
                    {
                      ref: "workspace",
                      address,
                      region,
                      access: executor.write ? "ReadWrite" : "ReadOnly",
                    },
                  ],
                },
          );
          const outcome = yield* executor
            .execute({ intent, definition, context, sandbox: handle, regions })
            .pipe(
              Effect.ensuring(sandbox.close(handle).pipe(Effect.orDie)),
              Effect.mapError(failure),
            );

          const settledAt = yield* clock.now();
          yield* tx.transact(
            store.settle(
              intent.invocationId,
              outcome.settlement,
              outcome.resultRef,
              settledAt,
            ),
          );

          const observation: CanonicalToolObservation = (() => {
            switch (outcome.settlement._tag) {
              case "Success":
                return {
                  _tag: "Success",
                  observation: outcome.observation,
                  resultRef: outcome.resultRef,
                };
              case "ExpectedFailure":
                return {
                  _tag: "ExpectedFailure",
                  observation: outcome.observation,
                };
              case "Interrupted":
                return { _tag: "Interrupted" };
              case "OutcomeUnknown":
                return {
                  _tag: "OutcomeUnknown",
                  reconciliationRefs: outcome.settlement.reconciliationRefs,
                };
              case "RuntimeFailure":
                return {
                  _tag: "RuntimeFailure",
                  cause: outcome.settlement.cause,
                };
            }
          })();
          return observation;
        }).pipe(Effect.mapError(failure));

      return ToolRuntimePort.of({ invoke });
    }),
  );

export { bounded };
