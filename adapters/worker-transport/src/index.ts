import type {
  CommandReceipt,
  WorkerId,
  WorkerIncarnationId,
} from "@arbor/domain";
import {
  type ExecutionOriginMutation,
  RemoteWorkerTransportPort,
  type TransportVersionRejected,
  type WorkerCommandRejection,
  type WorkerTransportProtocolVersion,
} from "@arbor/ports";
import { Effect, Layer } from "effect";

/**
 * P12 `06` §4.1 — the worker-side transport adapter.
 *
 * This package holds NO canonical DB capability: it depends only on
 * `domain` + `ports`, never on `adapters/persistence-sqlite`, and its `Layer`
 * requirement `R` excludes `SqlClient` (CI-1). A remote worker can therefore
 * never obtain a canonical DB connection; it only negotiates a protocol
 * version and submits a wire mutation.
 */

export interface AuthenticatedPeer {
  readonly workerId: WorkerId;
  readonly workerIncarnationId: WorkerIncarnationId;
}

export interface WorkerTransportOptions {
  /** The locally supported protocol version. */
  readonly localVersion: WorkerTransportProtocolVersion;
  /** The peer identity proven by mutual authentication out-of-band (never
   * asserted by the payload). */
  readonly peer: AuthenticatedPeer;
  /** The control-plane submission boundary. Bound at composition; the
   * adapter itself has no canonical capability. */
  readonly send: (
    peer: AuthenticatedPeer,
    mutation: ExecutionOriginMutation,
  ) => Effect.Effect<
    CommandReceipt<unknown, WorkerCommandRejection>,
    TransportVersionRejected
  >;
}

/**
 * Version negotiation: only a compatible **major** is accepted; an
 * incompatible major is the named typed rejection `TransportVersionRejected`,
 * never a silent downgrade. On success the negotiated minor is the lower of
 * the two.
 */
export const negotiateVersion = (
  local: WorkerTransportProtocolVersion,
  peer: WorkerTransportProtocolVersion,
): Effect.Effect<WorkerTransportProtocolVersion, TransportVersionRejected> =>
  local.major === peer.major
    ? Effect.succeed({
        major: local.major,
        minor: Math.min(local.minor, peer.minor),
      })
    : Effect.fail({
        _tag: "TransportVersionRejected",
        localMajor: local.major,
        peerMajor: peer.major,
      });

export const WorkerTransportLive = (
  options: WorkerTransportOptions,
): Layer.Layer<RemoteWorkerTransportPort> =>
  Layer.succeed(RemoteWorkerTransportPort, {
    negotiate: (peer) => negotiateVersion(options.localVersion, peer),
    submit: (mutation) => options.send(options.peer, mutation),
  });
