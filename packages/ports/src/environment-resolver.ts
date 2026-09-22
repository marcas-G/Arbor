import type {
  ProjectId,
  ResourceAddress,
  SnapshotRegionEntry,
} from "@arbor/domain";
import { Context, type Effect } from "effect";
import type { EnvironmentObservation } from "./environment-change.js";

/**
 * P11 `04` (GQ2/GQ3') — the REAL environment resolver port (P11-003).
 * Sits beside `ProjectEnvironmentPort` (whose signature is frozen at
 * P11 contract shape); this port produces full observations.
 *
 * OBSERVATION-ONLY (highest constraint):
 *  - reads the environment revision counter (never advances it — CI-1);
 *  - probes fs/git for the requested addresses;
 *  - derives fingerprint + snapshotBlobRef from the P11-002 canonical
 *    construction path (same canonical bytes for both).
 *
 * The service signature carries NO write capability: no TransactionScope,
 * no advancement, no change recording, and no blob persistence — the
 * resolver only produces the `blob:<digest>` ref VALUE; persisting blob
 * content to the blob store is REC's snapshotBlobRef consumer side.
 */
export type EnvironmentResolverError =
  | { readonly _tag: "ProbeFailed"; readonly cause: unknown }
  | { readonly _tag: "CanonicalizationFailed"; readonly cause: unknown }
  | { readonly _tag: "BlobFailure"; readonly cause: unknown };

/**
 * A full observation: structurally an `EnvironmentObservation` (feeds
 * RecordEnvironmentChange / the re-probe seam unchanged) plus the probe
 * entries the fingerprint was derived from — the audit surface that
 * distinguishes `exists:false` (a valid observation) from a typed
 * probe failure.
 */
export interface ResolverObservation extends EnvironmentObservation {
  readonly entries: ReadonlyArray<SnapshotRegionEntry>;
}

export interface EnvironmentResolverService {
  readonly observe: (
    projectId: ProjectId,
    addresses: ReadonlyArray<ResourceAddress>,
  ) => Effect.Effect<ResolverObservation, EnvironmentResolverError, never>;
}

export class EnvironmentResolverPort extends Context.Service<
  EnvironmentResolverPort,
  EnvironmentResolverService
>()("arbor/EnvironmentResolverPort") {}
