import type { CanonicalResourceRegion, ResourceAddress } from "@arbor/domain";
import {
  type ArtifactServiceService,
  type BoundedObservation,
  type CanonicalToolObservation,
  Clock,
  ProjectEnvironmentPort,
  ResourceAdmission,
  type SandboxHandle,
  SandboxPort,
  type ToolDefinition,
  ToolDefinitionStore,
  type ToolExecutionContext,
  type ToolIntent,
  type ToolInvocationSettlement,
  ToolInvocationStore,
  type ToolRuntimeError,
  ToolRuntimePort,
  TransactionPort,
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

const resourceArguments = (
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
          const resolved = yield* environment.resolve(
            context.projectId,
            resourceArguments(intent.argumentsJson),
          );
          const regions = resolved.regions;

          const authority = checkInvocationAuthority({
            authority: context.authority,
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

          const handle = yield* sandbox.open({
            executionId: context.executionId,
            workspaceId: context.workspaceId,
            regions,
          });
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
