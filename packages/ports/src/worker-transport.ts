import type {
  CommandEnvelope,
  CommandReceipt,
  DomainError,
  ExecutionId,
  LeaseGeneration,
  WorkerId,
  WorkerIncarnationId,
} from "@arbor/domain";
import { Context, type Effect } from "effect";

/**
 * P12 `06` §4 — Remote Worker transport surface (G6).
 *
 * The wire contract is declared in `domain`/`ports` terms only. The
 * application-level authority / rejection types (`VerifiedRuntimeCommandAuthority`,
 * `CommandRejection`) stay control-plane-side in the mediation layer
 * (`packages/application`); a `ports → application` edge is forbidden
 * (DID §10.4.1).
 */

export interface WorkerTransportProtocolVersion {
  readonly major: number;
  readonly minor: number;
}

export interface TransportVersionRejected {
  readonly _tag: "TransportVersionRejected";
  readonly localMajor: number;
  readonly peerMajor: number;
}

/**
 * Wire-level terminal rejection, in `domain`/`ports` terms only. The control
 * plane maps its application-level `CommandRejection` onto this bounded set at
 * the boundary. `FencingRejected` here is a DISTINCT ports-level structural
 * type (not the application `CommandRejection` member).
 */
export type WorkerCommandRejection =
  | DomainError
  | { readonly _tag: "FencingRejected" }
  | { readonly _tag: "ExecutionStopping" }
  | { readonly _tag: "ExecutionNotFound"; readonly executionId: ExecutionId };

/**
 * The wire command envelope: the frozen domain `CommandEnvelope` plus the
 * routing discriminator `commandType` that the control plane needs to resolve
 * the command handler. Declared here (never `packages/application`) so the
 * wire contract imports no application type.
 */
export type WireCommandEnvelope<C> = CommandEnvelope<C> & {
  readonly commandType: string;
};

/**
 * P12 `06` §6.2 (E-14). The worker submits this DTO; it carries ONLY the
 * authenticated identity (`workerId`, `workerIncarnationId`), the fence triple
 * `(workerId, workerIncarnationId, fencingGeneration)`, the target
 * `executionId`, and the `CommandEnvelope`. It carries **no** authority fact:
 * the trusted `VerifiedRuntimeCommandAuthority` and the `ExecutionOrigin`
 * context are constructed control-plane-side from authenticated facts.
 */
export interface ExecutionOriginMutation {
  readonly workerId: WorkerId;
  readonly workerIncarnationId: WorkerIncarnationId;
  readonly executionId: ExecutionId;
  readonly fencingGeneration: LeaseGeneration;
  readonly envelope: WireCommandEnvelope<unknown>;
}

export interface RemoteWorkerTransportPortService {
  readonly negotiate: (
    peer: WorkerTransportProtocolVersion,
  ) => Effect.Effect<WorkerTransportProtocolVersion, TransportVersionRejected>;
  readonly submit: (
    mutation: ExecutionOriginMutation,
  ) => Effect.Effect<
    CommandReceipt<unknown, WorkerCommandRejection>,
    TransportVersionRejected
  >;
}

export class RemoteWorkerTransportPort extends Context.Service<
  RemoteWorkerTransportPort,
  RemoteWorkerTransportPortService
>()("arbor/RemoteWorkerTransportPort") {}
