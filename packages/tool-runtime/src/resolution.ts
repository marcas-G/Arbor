import type {
  CanonicalResourceRegion,
  ProjectId,
  ResourceAddress,
} from "@arbor/domain";
import { type EnvironmentError, ProjectEnvironmentPort } from "@arbor/ports";
import { Effect } from "effect";

/** P4 `05` §2; DID v1.8 §1.5. Canonical resolution happens before admission and
 * outside the sandbox; the P1/P2 resolver owns alias resolution. */
export const resolveRegions = (
  projectId: ProjectId,
  addresses: ReadonlyArray<ResourceAddress>,
): Effect.Effect<
  ReadonlyArray<CanonicalResourceRegion>,
  EnvironmentError,
  ProjectEnvironmentPort
> =>
  Effect.gen(function* () {
    const environment = yield* ProjectEnvironmentPort;
    const resolved = yield* environment.resolve(projectId, addresses);
    return resolved.regions;
  });
