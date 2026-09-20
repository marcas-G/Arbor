import {
  type CanonicalResourceRegion,
  regionContains,
  type WorkspaceId,
} from "@arbor/domain";
import {
  type AdmissionResult,
  ProjectEnvironmentPort,
  ResourceAdmission,
  type ResourceAdmissionError,
  ResourceOwnershipRepository,
  resourceRegionComparator,
  type TransactionScope,
  WorkspaceRepository,
} from "@arbor/ports";
import { Effect, Layer, Option } from "effect";

/** P4 `05` §3; DID v1.8 G4; SD v1.3 §4.4. Validate-only: never mutates
 * `resource_ownership`. */

const deny = (reason: string): AdmissionResult => ({ _tag: "Denied", reason });
const admitted: AdmissionResult = { _tag: "Admitted" };

const contains = (
  container: CanonicalResourceRegion,
  region: CanonicalResourceRegion,
): boolean => regionContains(container, region, resourceRegionComparator);

export const ResourceAdmissionLive: Layer.Layer<
  ResourceAdmission,
  never,
  WorkspaceRepository | ResourceOwnershipRepository | ProjectEnvironmentPort
> = Layer.effect(
  ResourceAdmission,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceRepository;
    const ownership = yield* ResourceOwnershipRepository;
    const environment = yield* ProjectEnvironmentPort;

    const admit = (input: {
      readonly workspaceId: WorkspaceId;
      readonly regions: ReadonlyArray<CanonicalResourceRegion>;
      readonly write: boolean;
    }): Effect.Effect<
      AdmissionResult,
      ResourceAdmissionError,
      TransactionScope
    > =>
      Effect.gen(function* () {
        const workspace = yield* workspaces.findById(input.workspaceId);
        if (Option.isNone(workspace)) {
          return deny("workspace not found");
        }
        const resolved = yield* environment.resolve(
          workspace.value.projectId,
          workspace.value.resourceBoundary.addresses,
        );
        for (const region of input.regions) {
          if (
            !resolved.regions.some((boundary) => contains(boundary, region))
          ) {
            return deny("region outside ResourceBoundary");
          }
        }
        if (input.write) {
          const claims = yield* ownership.listActiveByWorkspace(
            input.workspaceId,
          );
          for (const region of input.regions) {
            if (!claims.some((claim) => contains(claim.region, region))) {
              return deny("region not owned");
            }
          }
        }
        return admitted;
      }).pipe(
        Effect.mapError(
          (cause): ResourceAdmissionError => ({
            _tag: "ResourceAdmissionError",
            cause,
          }),
        ),
      );

    return ResourceAdmission.of({ admit });
  }),
);
