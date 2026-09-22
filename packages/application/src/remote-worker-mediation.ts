import type {
  CommandReceipt,
  CommandSubmissionContext,
  Principal,
  SemanticRequestFingerprint,
  WorkerId,
  WorkerIncarnationId,
} from "@arbor/domain";
import {
  Clock,
  type ExecutionOriginMutation,
  type TransportVersionRejected,
} from "@arbor/ports";
import { Context, Effect, Layer, Option } from "effect";
import type { VerifiedRuntimeCommandAuthority } from "./authority.js";
import {
  FINGERPRINT_ALGORITHM_VERSION,
  semanticRequestFingerprint,
} from "./fingerprint.js";
import {
  CommandGateway,
  type CommandGatewayError,
  CommandHandlerRegistry,
} from "./gateway.js";
import type { CommandRejection } from "./rejection.js";

/**
 * P12 `06` §6.1 (E-12) — the control-plane fenced submission mediation
 * entry point.
 *
 * Declared in `packages/application` (NOT `ports`, which would create a
 * forbidden `ports → application` edge, DID §10.4.1). It is the only layer
 * that references the application authority/rejection types.
 *
 * The mediation port is a thin adapter over `CommandGateway`: it derives the
 * trusted `VerifiedRuntimeCommandAuthority` and the authenticated
 * `ExecutionOrigin` context from the authenticated facts (never from the
 * payload), then delegates. The single `TransactionPort.transact` is the
 * gateway's (CI-1): this port MUST NOT open its own transaction, and MUST NOT
 * perform command resolution or domain event append itself.
 */
export interface RemoteWorkerMediationPortService {
  readonly submit: (
    peer: {
      readonly workerId: WorkerId;
      readonly workerIncarnationId: WorkerIncarnationId;
    },
    mutation: ExecutionOriginMutation,
  ) => Effect.Effect<
    CommandReceipt<unknown, CommandRejection>,
    TransportVersionRejected | CommandGatewayError
  >;
}

export class RemoteWorkerMediationPort extends Context.Service<
  RemoteWorkerMediationPort,
  RemoteWorkerMediationPortService
>()("arbor/RemoteWorkerMediationPort") {}

const authorityDenied = (reason: string): CommandRejection => ({
  _tag: "AuthorityDenied",
  reason,
});

/**
 * Builds the command-specific trusted runtime authority from authenticated
 * facts only. `SettleExecution` and `StopExecution` are the ExecutionOrigin
 * commands representable by `(executionId, fencingGeneration)`; any other
 * command is not a remote-worker mutation and is rejected (never delegated).
 */
const buildAuthority = (
  mutation: ExecutionOriginMutation,
  principal: Principal,
  semanticRequestFingerprint: SemanticRequestFingerprint,
): VerifiedRuntimeCommandAuthority | null => {
  const base = {
    principal,
    commandId: mutation.envelope.commandId,
    semanticRequestFingerprint,
    projectId: mutation.envelope.projectId,
  };
  switch (mutation.envelope.commandType) {
    case "SettleExecution":
      return {
        ...base,
        _tag: "SettleExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        commandKind: "SettleExecution",
        executionId: mutation.executionId,
        fencingGeneration: mutation.fencingGeneration,
      };
    case "StopExecution":
      return {
        ...base,
        _tag: "StopExecutionAuthority",
        submissionOrigin: "ExecutionOrigin",
        commandKind: "StopExecution",
        executionId: mutation.executionId,
      };
    default:
      return null;
  }
};

export const RemoteWorkerMediationPortLive: Layer.Layer<
  RemoteWorkerMediationPort,
  never,
  CommandGateway | CommandHandlerRegistry | Clock
> = Layer.effect(
  RemoteWorkerMediationPort,
  Effect.gen(function* () {
    const gateway = yield* CommandGateway;
    const registry = yield* CommandHandlerRegistry;
    const clock = yield* Clock;

    const submit: RemoteWorkerMediationPortService["submit"] = (
      peer,
      mutation,
    ) =>
      Effect.gen(function* () {
        const handlerOption = registry.lookup(mutation.envelope.commandType);
        const schemaVersion = Option.isSome(handlerOption)
          ? handlerOption.value.schemaVersion
          : "1";
        const fingerprint = semanticRequestFingerprint({
          commandType: mutation.envelope.commandType,
          projectId: mutation.envelope.projectId,
          actor: mutation.envelope.actor,
          schemaVersion,
          payload: mutation.envelope.payload,
        });
        const now = yield* clock.now();
        const rejected = (
          error: CommandRejection,
        ): CommandReceipt<unknown, CommandRejection> => ({
          commandId: mutation.envelope.commandId,
          projectId: mutation.envelope.projectId,
          semanticRequestFingerprint: fingerprint,
          schemaVersion,
          fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
          resolution: { _tag: "TerminalRejected", error },
          createdAt: now,
          settledAt: now,
        });

        // Identity binding (M2): the wire DTO may not assert another worker's
        // identity. Reject before delegating to the gateway.
        if (
          mutation.workerId !== peer.workerId ||
          mutation.workerIncarnationId !== peer.workerIncarnationId
        ) {
          return rejected(
            authorityDenied("authenticated peer identity mismatch"),
          );
        }
        if (Option.isNone(handlerOption)) {
          return rejected(
            authorityDenied(
              `no command handler for ${mutation.envelope.commandType}`,
            ),
          );
        }

        const principal = peer.workerId as unknown as Principal;
        const context: CommandSubmissionContext = {
          _tag: "ExecutionOrigin",
          principal,
          executionId: mutation.executionId,
          fencingGeneration: mutation.fencingGeneration,
          workerId: peer.workerId,
          workerIncarnationId: peer.workerIncarnationId,
        };
        const authority = buildAuthority(mutation, principal, fingerprint);
        if (authority === null) {
          return rejected(
            authorityDenied(
              `unsupported execution-origin command ${mutation.envelope.commandType}`,
            ),
          );
        }
        return yield* gateway.execute(mutation.envelope, context, authority);
      });

    return RemoteWorkerMediationPort.of({ submit });
  }),
);
